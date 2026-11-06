"""Bounded Youzhiyouxing workbook transport; parsed values stay declared data."""
import io
import posixpath
import re
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile

from fastapi import HTTPException

NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
LABELS={'CNY':'人民币','USD':'美元','HKD':'港币','GBP':'英镑','EUR':'欧元','JPY':'日元','KRW':'韩元','SGD':'新加坡元','AUD':'澳元','CAD':'加元','INR':'印度卢比','TWD':'新台币','BRL':'巴西雷亚尔'}
CODES={v:k for k,v in LABELS.items()}|{'港元':'HKD','雷亚尔':'BRL'}
EPOCH=date(1899,12,30)


def number(value):
    if value is None or value=='': return None
    try:
        out=Decimal(str(value))
        if not out.is_finite() or len(str(out))>100: raise ValueError()
        return out
    except (ValueError,InvalidOperation):
        raise HTTPException(422,'工作表金额无效') from None


def xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper(): raise HTTPException(422,'工作表实体不允许')
    return ET.fromstring(raw)


def parse(raw):
    if len(raw)>10*1024*1024: raise HTTPException(413,'文件不能超过10MiB')
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            entries=archive.infolist()
            if len(entries)>2000 or len({x.filename for x in entries})!=len(entries) or sum(x.file_size for x in entries)>50*1024*1024: raise HTTPException(413,'工作簿解压预算超限')
            data={}
            for entry in entries:
                if entry.flag_bits&1 or entry.file_size>20*1024*1024 or entry.file_size>max(1,entry.compress_size)*200: raise HTTPException(413,'工作簿条目预算超限')
                with archive.open(entry) as stream: content=stream.read(entry.file_size+1)
                if len(content)!=entry.file_size: raise HTTPException(422,'工作簿长度无效')
                data[entry.filename]=content
        shared=[]
        if 'xl/sharedStrings.xml' in data:
            shared=[''.join(n.text or '' for n in x.iter(NS+'t')) for x in xml(data['xl/sharedStrings.xml']).findall(NS+'si')]
        workbook=xml(data['xl/workbook.xml']);rels=xml(data['xl/_rels/workbook.xml.rels'])
        targets={}
        for rel in rels:
            if rel.get('TargetMode')=='External':raise HTTPException(422,'工作簿不接受外部关系')
            name=rel.get('Target','')
            path=posixpath.normpath(name.lstrip('/') if name.startswith('/') else 'xl/'+name)
            if '..' in name.split('/') or not path.startswith('xl/worksheets/') or path not in data:continue
            targets[rel.get('Id')]=path
        sheets=[]
        for sheet in workbook.findall(NS+'sheets/'+NS+'sheet'):
            path=targets.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
            if path is None or path in sheets:raise HTTPException(422,'工作表登记关系无效')
            sheets.append(path)
        date1904=workbook.find(NS+'workbookPr')
        date1904=date1904 is not None and date1904.get('date1904') in ('1','true')
        styles=[]
        if 'xl/styles.xml' in data:
            style=xml(data['xl/styles.xml'])
            formats={int(node.get('numFmtId')):node.get('formatCode','') for node in style.findall(NS+'numFmts/'+NS+'numFmt')}
            for node in style.findall(NS+'cellXfs/'+NS+'xf'):
                code=int(node.get('numFmtId','0'));fmt=re.sub(r'"[^"]*"|\\.', '',formats.get(code,''))
                styles.append(code in {*range(14,23),*range(27,37),*range(45,48),*range(50,59)} or bool(re.search('[yd]',fmt,re.IGNORECASE)))
        if len(sheets)>100: raise HTTPException(413,'工作表超过100个')
        total=0; result=[]
        for path in sheets:
            rows=[]
            for row in xml(data[path]).iter(NS+'row'):
                rn=int(row.get('r','0'))
                if not 1<=rn<=10000 or rn<=len(rows):raise HTTPException(422,'工作表行编号或顺序无效')
                while len(rows)<rn-1:rows.append([None]*7)
                cells={}
                for cell in row.findall(NS+'c'):
                    col=re.match(r'[A-Z]+',cell.get('r',''))
                    if not col: continue
                    index=0
                    for char in col[0]: index=index*26+ord(char)-64
                    if index>32: continue
                    v=cell.find(NS+'v'); value=v.text if v is not None else None
                    if cell.get('t')=='s': value=shared[int(value)]
                    elif cell.get('t')=='inlineStr': value=''.join(n.text or '' for n in cell.iter(NS+'t'))
                    elif cell.get('t')=='d':
                        observed=datetime.fromisoformat(value)
                        if observed.tzinfo:observed=observed.astimezone(UTC)
                        value=str((observed.date()-EPOCH).days)
                    elif date1904 and value is not None and cell.get('s') is not None:
                        style_index=int(cell.get('s'))
                        if not 0<=style_index<len(styles):raise HTTPException(422,'工作表日期样式无效')
                        if styles[style_index]:value=str(number(value)+1462)
                    cells[index]=value
                rows.append([cells.get(i) for i in range(1,8)])
            total+=len(rows)
            if len(rows)>10000 or total>50000: raise HTTPException(413,'工作表行数超限')
            if len(rows)<2 or rows[0][0]!='账户名称' or not rows[1][0]: continue
            start=next((i+1 for i,row in enumerate(rows) if row[0]=='记录类型'),None)
            if start is None: continue
            days={}
            for row in rows[start:]:
                if row[0] not in ('记总资产','转入转出'): continue
                serial=number(row[1])
                if serial is None or not 10000<=serial<=80000: continue
                day=(EPOCH+timedelta(days=int(serial))).isoformat()
                item=days.setdefault(day,{'v':None,'inn':Decimal(0),'out':Decimal(0)})
                amount=number(row[3])
                if amount is not None: item['v']=amount
                if row[0]=='转入转出':
                    flow=number(row[2])
                    if flow is not None: item['inn' if flow>=0 else 'out']+=abs(flow)
            hist=[];
            for day,item in sorted(days.items()):
                # No inferred initial value or inferred capital: observations and
                # explicit flows stay distinct. A flow alone is not a valuation.
                if item['v'] is not None: item['v']
                hist.append({'d':day,'v':str(item['v']) if item['v'] is not None else None,'inn':str(item['inn']),'out':str(item['out'])})
            if not hist: continue
            meta=rows[1]; currency=CODES.get(meta[4],meta[4] if meta[4] in LABELS else None)
            bucket='活钱' if '活钱' in str(meta[5]) else '稳健' if '稳健' in str(meta[5]) else '长期'
            expected=re.search(r'[\d.]+',str(meta[2] or ''))
            result.append({'id':'','name':str(meta[0]).strip(),'cur':currency,'amount':hist[-1]['v'],'bucket':bucket,'market':None,'expected':str(number(expected[0])) if expected else None,'inAmt':None,'outAmt':None,'updated':hist[-1]['d'],'hist':hist,'sourceSheet':path,'capitalBasisKnown':False,'marketInferred':False})
        if not result: raise HTTPException(422,'未识别到投资记账数据')
        return result
    except HTTPException: raise
    except (ValueError,KeyError,IndexError,TypeError,ET.ParseError, OSError, BadZipFile) as exc:
        raise HTTPException(422,'无法解析该xlsx文件') from exc


def export(invest):
    if not isinstance(invest,list) or not 1<=len(invest)<=200: raise HTTPException(400,'投资账户须为1至200个')
    output=io.BytesIO();names=[]; total=0
    with ZipFile(output,'w',ZIP_DEFLATED) as archive:
        for index,item in enumerate(invest,1):
            if not isinstance(item,dict): raise HTTPException(400,'投资账户无效')
            hist=item.get('hist') or []
            if not isinstance(hist,list) or len(hist)>10000: raise HTTPException(413,'历史行数超限')
            if not hist and item.get('updated') and item.get('amount') is not None: hist=[{'d':str(item['updated'])[:10],'v':item['amount']}]
            rows=[['账户名称','账户目标','预期年化收益率','预计投资时间','币种','四笔钱'],[item.get('name'),' ',str(item['expected'])+'%' if item.get('expected') is not None else '',None,LABELS.get(item.get('cur'),item.get('cur')),{'活钱':'活钱管理','稳健':'稳健理财'}.get(item.get('bucket'),'长期投资')],[],['记录类型','记账时间','转入转出金额','总资产金额','投资日志','创建时间','明细']]
            for point in sorted(hist,key=lambda h:str(h.get('d',''))):
                try: day=date.fromisoformat(str(point['d'])[:10]); serial=(day-EPOCH).days
                except (ValueError,KeyError,TypeError): raise HTTPException(422,'历史日期无效') from None
                val=number(point.get('v'))
                if val is not None: rows.append(['记总资产',serial,None,val,None,None,''])
                inn=number(point.get('inn'));out=number(point.get('out'))
                if inn is not None or out is not None:
                    flow=(inn or Decimal(0))-(out or Decimal(0))
                    if flow: rows.append(['转入转出',serial,flow,val,None,None,''])
            total+=len(rows)
            if total>50000: raise HTTPException(413,'导出总行数超限')
            root=ET.Element('worksheet',xmlns=NS[1:-1]);sheet=ET.SubElement(root,'sheetData')
            for rn,row in enumerate(rows,1):
                node=ET.SubElement(sheet,'row',r=str(rn))
                for cn,value in enumerate(row):
                    if value is None: continue
                    cell=ET.SubElement(node,'c',r=chr(65+cn)+str(rn))
                    if isinstance(value,(Decimal,int)):
                        ET.SubElement(cell,'v').text=str(value)
                    else:
                        cell.set('t','inlineStr');ET.SubElement(ET.SubElement(cell,'is'),'t').text=str(value)
            archive.writestr(f'xl/worksheets/sheet{index}.xml',ET.tostring(root))
            name=re.sub(r'[\[\]:*?/\\]','',str(item.get('name') or '账户'))[:25]+str(index); names.append(name)
        ct='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1,len(names)+1))+'</Types>'
        archive.writestr('[Content_Types].xml',ct)
        archive.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        workbook=ET.Element('workbook',xmlns=NS[1:-1]); sheets=ET.SubElement(workbook,'sheets')
        for i,name in enumerate(names,1): ET.SubElement(sheets,'sheet',name=name,sheetId=str(i),attrib={'{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id':f'rId{i}'})
        archive.writestr('xl/workbook.xml',ET.tostring(workbook))
        archive.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,len(names)+1))+'</Relationships>')
    return output.getvalue()
