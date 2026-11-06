"""Legacy authenticated layout fields in the existing SiteSettings JSON authority.

These are presentation declarations, never holdings, broker ownership or quote facts.
"""
import re
from fastapi import HTTPException

COLUMNS=('identity','marketValue','cost','price','qty','dayPnl','dayPnlRate','pnl','pnlRate','weight')
TABS={'holdings':'账户资产','assets':'资产分析','watchlist':'自选股','global':'全球经济','trading':'动态','earnings':'财报日历','celebs':'名人持仓','users':'用户管理','attachments':'附件管理','library':'素材库','cards':'卡面库','activities':'日志','settings':'设置'}
DEFAULTS={'tabs':[],'markets':[],'marketLabels':[],'assetMarketOrder':[],'assetAnalysisOrder':{'left':[],'right':[]},'indicesOrder':[],
    'holdingColumns':[{'key':key,'visible':key!='dayPnlRate'}for key in COLUMNS],'stockIconCdn':False,'appDisplayName':'','appDisplayIcon':None}


def text(raw,maximum):
    if not isinstance(raw,str)or len(raw.encode('utf-16-le'))//2>maximum or re.search(r'[\x00-\x1f\x7f]',raw):raise HTTPException(400,'布局文字无效')
    return raw.strip()


def strings(raw):
    if not isinstance(raw,list)or len(raw)>2000:raise HTTPException(400,'布局顺序数组无效')
    result=[];seen=set()
    for value in raw:
        if not isinstance(value,str)or not value.strip()or value in seen:continue
        text(value,100);seen.add(value);result.append(value)
    return result


def normalize(key,raw):
    if key=='stockIconCdn':
        if type(raw)is not bool:raise HTTPException(400,'图标选项须为布尔值')
        return raw
    if key=='appDisplayName':return text(raw,100)
    if key in ('markets','assetMarketOrder','indicesOrder'):
        values=strings(raw)
        return [s.strip()for s in values]if key=='markets'else values
    if key=='assetAnalysisOrder':
        if not isinstance(raw,dict)or set(raw)-{'left','right'}:raise HTTPException(400,'分析布局无效')
        return {side:strings(raw.get(side,[]))for side in ('left','right')}
    if not isinstance(raw,list)or len(raw)>2000:raise HTTPException(400,'布局数组无效')
    result=[];seen=set()
    if key=='holdingColumns':
        for item in raw:
            if not isinstance(item,dict)or item.get('key')not in COLUMNS or item['key']in seen:continue
            seen.add(item['key']);result.append({'key':item['key'],'visible':item.get('visible')is not False})
        return result+[dict(item)for item in DEFAULTS[key]if item['key']not in seen]
    for item in raw:
        if not isinstance(item,dict)or not isinstance(item.get('key'),str)or item['key']in seen:continue
        ident=item['key']
        if key=='tabs':
            if ident not in TABS or not isinstance(item.get('label'),str):continue # user-retired FIRE is not restored
            seen.add(ident);url=item.get('url');fallback='/asset-analysis'if ident=='assets'else'/'+ident
            if not isinstance(url,str)or not url.startswith('/')or url.startswith('//')or re.search(r'[?#\\\x00-\x20]',url):url=fallback
            if ident=='assets'and url=='/assets':url='/asset-analysis'
            value={'key':ident,'label':text(item['label'],100)or TABS[ident],'url':url.rstrip('/')or fallback,'default':item.get('default')is True}
            if value['default']and any(v.get('default')for v in result):value['default']=False
            result.append(value)
        elif key=='marketLabels':
            if not ident or not isinstance(item.get('label'),str)or item.get('flag')is not None and not isinstance(item['flag'],str):continue
            text(ident,100);seen.add(ident);result.append({'key':ident,'label':text(item['label'],100)or ident,'flag':text(item.get('flag')or'🌍',50)or'🌍'})
    if key=='tabs':
        for ident,label in TABS.items():
            if ident not in seen:result.append({'key':ident,'label':label,'url':'/asset-analysis'if ident=='assets'else'/'+ident})
        if result and not any(v.get('default')for v in result):result[0]['default']=True
    return result


async def project(conn,row):
    source=row['settings']if row else{}
    values={key:source.get(key,default)for key,default in DEFAULTS.items()}
    icon=values['appDisplayIcon']
    if icon:
        asset=await(await conn.execute('SELECT public_path,served_sha256 FROM system_asset_versions WHERE id=%s AND kind=%s',(icon,'ico'))).fetchone()
        if not asset:raise HTTPException(503,'连接图标登记版本不可用')
        values['appDisplayIcon']=asset['public_path']+'?sha256='+asset['served_sha256']
    else:values['appDisplayIcon']=''
    return values
