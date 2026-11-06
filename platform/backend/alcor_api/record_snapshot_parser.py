"""Apple Vision geometry parser ported from the original snapshotParser.ts.

Heuristic fields are editable OCR candidates, never verified holdings or prices.
"""
import math
import re

from .card_preferences import JS_WHITESPACE

CJK=r'[\u3400-\u9fff]'
CODE_STOP=set('ETF ETFS USD HKD CNY RMB US HK CN INC LTD CORP CO PLC'.split())
NAME_STOP=set('NASDAQ NYSE AMEX OTC SPX INDEX NASDAQ100 SSE SZSE BSE HONG KONG CHINA UNITED STATES STOCK MARKET A股 美股 港股 US HK CN JP KR SG UK A SH SZ BJ'.split())
SUFFIX=r'\.(US|HK|JP|KS|KQ|L|SG|SH|SZ|BJ)$'


def classify(text):
    t=text.strip(JS_WHITESPACE)
    if not t:return 'other'
    if re.fullmatch(r'[+-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?%',t) or re.fullmatch(r'[+-]?[0-9]+(?:\.[0-9]+)?%',t):return 'percent'
    if re.search('[万亿]',t) and re.search(r'[0-9]',t):return 'money'
    if re.fullmatch(r'[+-]?[0-9,]+(?:\.[0-9]+)?(?:股|份|张|手|万元|亿美元)',t):return 'qty'
    if re.fullmatch(r'[A-Z0-9.]+\.(US|HK|JP|KS|KQ|L|SG|SH|SZ|BJ)',t,re.I|re.ASCII):return 'code'
    if re.fullmatch(r'[A-Z]{2,5}',t) and t not in CODE_STOP:return 'code'
    if re.fullmatch(r'(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{2,12}',t):return 'code'
    if re.fullmatch(r'[0-9]{4,6}',t):return 'code'
    if re.fullmatch(r'[+-]?[0-9,]+(?:\.[0-9]+)?',t):return 'number'
    if re.search(CJK,t):return 'name'
    if re.fullmatch(r"[A-Za-z][A-Za-z .&'-]*",t) and t.upper() not in NAME_STOP:return 'name'
    return 'other'


def market_from_code(code):
    c=code.upper()
    for pattern,market in [(r'\.(SH|SZ|BJ)$','CN'),(r'\.US$','US'),(r'\.HK$','HK'),(r'\.JP$','JP'),(r'\.(KS|KQ)$','KR'),(r'\.SG$','SG'),(r'\.L$','UK'),(r'^(SH|SZ|BJ)[0-9]{6}$','CN'),(r'^[0-9]{6}$','CN'),(r'^[0-9]{4,5}$','HK'),(r'^[A-Z]{2,5}$','US')]:
        if re.search(pattern,c):return market
    return ''


def number(text,percent=False):
    cleaned=re.sub(r'[,，%]' if percent else r'[,，¥$HK€£%]','',text)
    cleaned=re.sub('[－—–]','-',cleaned)
    if not percent:cleaned=re.sub(r'(美元|港元|元|股|份|张|手)$','',cleaned)
    cleaned=cleaned.strip(JS_WHITESPACE)
    try:
        value=float(cleaned) if cleaned else 0.0
        return value if math.isfinite(value) else None
    except ValueError:return None


def cluster_lines(lines):
    if not isinstance(lines,list) or len(lines)>20000:raise ValueError('vision_line_budget')
    positioned=[]
    for item in lines:
        if (not isinstance(item,dict) or not isinstance(item.get('text'),str) or len(item['text'])>8192
                or any(type(item.get(k)) not in (int,float) or not math.isfinite(item[k]) for k in ('x','y','w','h'))):raise ValueError('vision_line_shape')
        positioned.append({'text':item['text'],'x':item['x'],'top':1-(item['y']+item['h']),'cy':1-(item['y']+item['h']/2)})
    positioned.sort(key=lambda p:p['top'])
    rows=[]
    for p in positioned:
        if rows and abs(p['cy']-rows[-1]['cy'])<0.015:rows[-1]['tokens'].append(p)
        else:rows.append({'cy':p['cy'],'tokens':[p]})
    return [sorted(r['tokens'],key=lambda t:t['x']) for r in rows]


def parse_row(tokens):
    texts=[t['text'] for t in tokens];joined=' '.join(texts).strip(JS_WHITESPACE)
    if not re.search(r'[A-Z0-9\u3400-\u9fff]',joined):return None
    kinds=[classify(t) for t in texts];codes=[t for t,k in zip(texts,kinds) if k=='code'];has_code=bool(codes)
    if not has_code and re.match(r'^(代码|名称|最新价|现价|涨跌幅|市值|持仓|成本|盈亏|序号|操作|数量|金额|方向)',joined):return None
    names=[t for t,k in zip(texts,kinds) if k=='name']
    if not has_code and not names:return None
    code=(next((t for t in codes if re.search(SUFFIX,t,re.I|re.ASCII)),codes[0]) if codes else '').strip(JS_WHITESPACE).upper()
    market=market_from_code(code)
    name=re.sub('['+re.escape(JS_WHITESPACE)+']+',' ',' '.join(t.strip(JS_WHITESPACE) for t in names if t.strip(JS_WHITESPACE) and t.strip(JS_WHITESPACE).upper() not in NAME_STOP)).strip(JS_WHITESPACE)
    name=name.encode('utf-16-le',errors='surrogatepass')[:200].decode('utf-16-le',errors='surrogatepass')
    if not has_code and name and not re.fullmatch(r'[\u3400-\u9fff·]{2,8}',name):return None
    if not has_code and name in set('自选股 我的持仓 持仓 行情 全部 关注 自选 总资产 账户 资产 交易 订单 更多 编辑 完成 搜索 刷新 今日 热门 首页 市场 板块 暂无数据 加载中 正在加载 更新时间'.split()):return None
    values={k:None for k in ('qty','price','cost','changePct')}
    labels={label:next(i for i,t in enumerate(texts) if label in t) for label in ('成本','现价','最新价','数量','持仓','市值') if any(label in t for t in texts)}
    for i,(text,kind) in enumerate(zip(texts,kinds)):
        if kind=='percent':
            if values['changePct'] is None:values['changePct']=number(text,True)
            continue
        if kind=='money':continue
        if kind=='qty':
            if values['qty'] is None:values['qty']=number(text)
            continue
        if kind!='number':continue
        value=number(text)
        if value is None:continue
        decimal=bool(re.search(r'\.[0-9]+',text))
        if '成本' in labels and i>labels['成本'] and values['cost'] is None:values['cost']=value;continue
        if any(label in labels and i>labels[label] for label in ('现价','最新价')) and values['price'] is None:values['price']=value;continue
        if any(label in labels and i>labels[label] for label in ('数量','持仓')) and values['qty'] is None and not decimal:values['qty']=value;continue
        fields=('qty','price') if not decimal else ('cost','price') if values['qty'] is not None else ('price','cost')
        for field in fields:
            if values[field] is None:values[field]=value;break
    if not code and not name:return None
    return {**({'name':name} if name else {}),**({'code':code} if code else {}),**({'market':market} if market else {}),**{k:v for k,v in values.items() if v is not None}}


def parse_snapshot(lines):
    result=[];seen=set()
    for tokens in cluster_lines(lines):
        row=parse_row(tokens)
        if not row:continue
        if row.get('code'):
            key=(row.get('market','?'),row['code'].upper())
            if key in seen:continue
            seen.add(key)
        result.append(row)
    return result[:100]


def raw_text(lines):return '\n'.join(' '.join(t['text'] for t in row) for row in cluster_lines(lines))
