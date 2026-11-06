"""Fixed original discovery protocols; pure parsing never guesses financial observations."""

import html
import json
import math
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, localcontext
from hashlib import sha256
from ipaddress import ip_address
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .card_preferences import JS_WHITESPACE
from .fx_provider_parser import unique
from .market_contract import canonical

VERSION='market-discovery-v1'
LIMIT=8*1024*1024
FILTERS={'US':'m:105,m:106,m:107','HK':'m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:8','CN':'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'}
EXCHANGES={'US':('AMEX','NYSE','NASDAQ'),'HK':('HKEX',),'CN':('SSE','SZSE','BSE')}
SCANNERS={'US':'america','HK':'hongkong','CN':'china'}
CURRENCIES={'US':'USD','HK':'HKD','CN':'CNY'}
INDEX_GROUPS=(('US','美股','🇺🇸',('usIXIC','usINX')),('HK','港股','🇭🇰',('hkHSI','hkHSTECH')),('CN','A股','🇨🇳',('sh000001','sz399001')),('F&G','恐惧与贪婪指数','🧠',()))
HOSTS={'tencent':('smartbox.gtimg.cn','qt.gtimg.cn'),'eastmoney':('push2.eastmoney.com','push2delay.eastmoney.com','searchapi.eastmoney.com'),
       'companiesmarketcap':('companiesmarketcap.com',),'tradingview':('scanner.tradingview.com',),'cnn':('production.dataviz.cnn.io',),'coingecko':('api.coingecko.com',)}


def digest(value):
    # Discovery transports expose legacy JSON numbers. Normalize them locally;
    # the exact financial-command canonicalizer must continue rejecting floats.
    def normalized(item):
        if isinstance(item,float):
            if not math.isfinite(item):
                raise ValueError('nonfinite_discovery_hash')
            item = Decimal(str(item))
        if isinstance(item,Decimal):
            if not item.is_finite():
                raise ValueError('nonfinite_discovery_hash')
            if item == item.to_integral_value():
                return int(item)
            with localcontext() as context:
                context.prec = max(100,len(item.as_tuple().digits))
                return item.normalize()
        if isinstance(item,(list,tuple)):
            return [normalized(child) for child in item]
        if isinstance(item,dict):
            return {key:normalized(child) for key,child in item.items()}
        return item
    return sha256(canonical(normalized(value)).encode()).hexdigest()


def query(raw):
    if not isinstance(raw,dict) or set(raw)-{'kind','market','q','metric'}:raise HTTPException(400,'发现查询参数无效')
    kind=raw.get('kind');market=raw.get('market');metric=raw.get('metric');text=raw.get('q','')
    if kind not in ('search','indices','top','ranking'):raise HTTPException(400,'发现查询类型无效')
    if kind=='search':
        if not isinstance(text,str):raise HTTPException(400,'搜索关键词无效')
        text=text.strip(JS_WHITESPACE)
        if len(text.encode('utf-16-le',errors='surrogatepass'))//2>50:raise HTTPException(400,'搜索关键词过长')
        try:text.encode('utf-8')
        except UnicodeError:raise HTTPException(400,'搜索关键词无效') from None
        return {'kind':kind,'q':text}
    if kind=='indices':return {'kind':kind}
    if kind=='top':
        if market not in ('US','HK','CN','JP','KR','ALL'):raise HTTPException(400,'market 参数无效')
        return {'kind':kind,'market':market}
    if market not in FILTERS:raise HTTPException(400,'不支持的排行市场')
    metric=metric or 'volume'
    if metric not in ('volume','amount'):raise HTTPException(400,'不支持的排行指标')
    return {'kind':kind,'market':market,'metric':metric}


def purpose(value):
    return 'discovery.'+value['kind']+('.'+value['metric'] if value['kind']=='ranking' else '')


@dataclass(frozen=True)
class Target:
    id:str
    source:str
    host:str
    addresses:tuple[str,...]
    approved_access:bool=False
    search_token:str|None=None

    def validate(self):
        if (not isinstance(self.id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',self.id)
                or self.source not in HOSTS or self.host not in HOSTS[self.source] or self.approved_access is not True
                or not isinstance(self.addresses,(tuple,list)) or not 1<=len(self.addresses)<=32):raise ValueError('discovery_target_not_approved')
        if self.search_token is not None and (not isinstance(self.search_token,str) or not 1<=len(self.search_token)<=256 or not self.search_token.isascii() or any(ord(char)<33 or ord(char)>126 for char in self.search_token)):raise ValueError('search_token_invalid')
        for value in self.addresses:
            address=ip_address(value)
            if not address.is_global or address.is_multicast or address.is_reserved:raise ValueError('discovery_public_pin_required')
        return self

    @property
    def fingerprint(self):return digest(asdict(self))

    def request(self,value):
        self.validate();kind=value['kind'];market=value.get('market')
        method,body='GET',None
        if self.source=='tencent' and kind=='search' and self.host=='smartbox.gtimg.cn':
            path='/s3/';params={'v':'2','q':value['q'],'t':'all'}
        elif self.source=='eastmoney' and kind=='search' and self.host=='searchapi.eastmoney.com':
            if not self.search_token:raise ValueError('operator_search_token_not_installed')
            path='/api/suggest/get';params={'input':value['q'],'type':'14','token':self.search_token,'count':'8'}
        elif self.source=='coingecko' and kind=='search':
            path='/api/v3/search';params={'query':value['q']}
        elif self.source=='tencent' and kind=='indices' and self.host=='qt.gtimg.cn':
            path='/';params={'q':','.join(symbol for _,_,_,symbols in INDEX_GROUPS for symbol in symbols)}
        elif self.source=='eastmoney' and kind in ('top','ranking') and market in FILTERS and self.host in ('push2.eastmoney.com','push2delay.eastmoney.com') and not (kind=='ranking' and value['metric']=='amount'):
            path='/api/qt/clist/get';field='f20' if kind=='top' else 'f5' if value['metric']=='volume' else 'f6'
            params={'pn':'1','pz':'100' if kind=='top' else '10','po':'1','np':'1','fltt':'2','invt':'2',
                    'fid':field,'fs':FILTERS[market],'fields':'f12,f14,f2,f3,f5,f6,f20,f124'}
        elif self.source=='companiesmarketcap' and kind=='top' and market in ('JP','KR','ALL'):
            path={'JP':'/japan/largest-companies-in-japan-by-market-cap/','KR':'/south-korea/largest-companies-in-south-korea-by-market-cap/','ALL':'/assets-by-market-cap/'}[market];params={}
        elif self.source=='tradingview' and kind=='ranking':
            path='/'+SCANNERS[market]+'/scan';params={};method='POST'
            columns=['name','description','volume','daily-bar.time','type','exchange'] if value['metric']=='volume' else ['name','description','high','volume','daily-bar.time','type','exchange','currency']
            body=json.dumps({'filter':[{'left':'type','operation':'equal','right':'stock'},{'left':'is_primary','operation':'equal','right':True},
                {'left':'exchange','operation':'in_range','right':EXCHANGES[market]}], 'columns':columns,
                'sort':{'sortBy':'volume','sortOrder':'desc'},'range':[0,10 if value['metric']=='volume' else 20000],'options':{'lang':'zh'}},separators=(',',':')).encode()
        elif self.source=='cnn' and kind=='indices':
            path='/index/fearandgreed/graphdata';params={}
        else:raise ValueError('discovery_protocol_not_installed_for_target')
        url='https://'+self.host+path+('?'+urlencode(params) if params else '')
        return method,url,body,{'target':['https',self.host,443,path],'addresses':list(self.addresses),'allow_plaintext':False}


def document(raw):
    return json.loads(raw,object_pairs_hook=unique,parse_float=Decimal,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite')))


def numeric(value,*,positive=False):
    if isinstance(value,bool) or value is None or not isinstance(value,(int,float,Decimal,str)) or str(value).strip() in ('','-'):return None
    try:result=Decimal(str(value))
    except ArithmeticError:return None
    if not result.is_finite() or abs(result)>Decimal('1e30') or positive and result<=0:return None
    displayed=float(result)
    return displayed if math.isfinite(displayed) and (displayed!=0 or result==0) else None


def iso(now):return now.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')


def amount_bound(high,volume):
    with localcontext() as context:
        context.prec=160
        return str(Decimal(str(high))*Decimal(str(volume))*Decimal('1.05'))


def stock_symbol(market,code):
    return ('bj' if code.startswith(('4','8','920')) else 'sh' if code.startswith(('6','9')) else 'sz')+code if market=='CN' else market.lower()+code


def tencent_quotes(raw):
    text=raw.decode('gb18030',errors='replace');result={}
    for symbol,content in re.findall(r'v_([^=]+)="([^"]*)"',text):
        fields=content.split('~')
        if len(fields)<35:continue
        price=numeric(fields[3],positive=True)
        if price is None:continue
        result[symbol]={'name':fields[1],'price':price,'open':numeric(fields[5]),'changePct':numeric(fields[32]),'time':fields[30]}
    return result


def parse(raw,target,value,now):
    if not isinstance(raw,bytes) or not raw or len(raw)>LIMIT:raise ValueError('discovery_page_budget')
    kind=value['kind'];market=value.get('market');items=[];groups=None;total=None;complete=False;extra={}
    if target.source=='tencent' and kind=='search':
        text=raw.decode('gb18030',errors='replace');hint=re.search(r'v_hint="([^"]*)"',text)
        if not hint:raise ValueError('tencent_hint_response_invalid')
        if hint:
            for row in hint[1].split('^'):
                parts=row.split('~')
                if len(parts)<5 or not parts[4].startswith('GP'):continue
                prefix,code,name=parts[:3]
                mapped={'sh':'CN','sz':'CN','bj':'CN','hk':'HK','us':'US','jp':'JP','kr':'KR'}.get(prefix)
                if not mapped:continue
                name=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),name).strip(JS_WHITESPACE)
                if not name:continue
                normalized=re.sub(r'\.(OQ|N|AM|PS|K)$','',code.upper()) if mapped=='US' else code.upper()
                items.append({'symbol':prefix+normalized,'code':normalized,'name':name,'market':mapped,'price':None,'changePct':None})
                if len(items)==8:break
        complete=True
    elif target.source=='eastmoney' and kind=='search':
        table=document(raw).get('QuotationCodeTable');rows=table.get('Data') if isinstance(table,dict) else None
        if not isinstance(rows,list):raise ValueError('eastmoney_search_invalid')
        for row in rows:
            code=str(row.get('Code','')).strip(JS_WHITESPACE).upper();name=str(row.get('Name','')).strip(JS_WHITESPACE);type_=str(row.get('SecurityTypeName',''))
            market='CN' if re.search('沪|深|京',type_) else 'HK' if '港' in type_ else 'US' if '美' in type_ else 'JP' if re.search('日|东京',type_) else 'KR' if re.search('韩|韩国',type_) else None
            if not code or not name or not market:continue
            normalized=re.sub(r'\.(OQ|N|AM|PS|K)$','',code) if market=='US' else re.sub(r'\.T$','',code) if market=='JP' else re.sub(r'\.(KS|KQ)$','',code) if market=='KR' else code.zfill(5) if market=='HK' else code
            items.append({'symbol':stock_symbol(market,normalized),'code':code,'name':name,'market':market,'price':None,'changePct':None})
            if len(items)==8:break
        complete=True
    elif target.source=='coingecko' and kind=='search':
        from .market_discovery_search import CRYPTO
        rows=document(raw).get('coins')
        if not isinstance(rows,list):raise ValueError('crypto_search_invalid')
        allowed={row['code'] for row in CRYPTO}
        for row in rows:
            code=str(row.get('symbol','')).upper();name=str(row.get('name','')).strip(JS_WHITESPACE);identifier=str(row.get('id') or row.get('symbol') or '').lower()
            if code not in allowed:continue
            if len(items)==5:break
            if code and name:items.append({'symbol':'CRYPTO:'+identifier,'code':code,'name':name,'market':'ASSET','price':None,'changePct':None,'type':'crypto'})
        complete=True
    elif target.source=='tencent' and kind=='indices':
        observed=tencent_quotes(raw);groups=[]
        for region,label,flag,symbols in INDEX_GROUPS:
            indices=[]
            for symbol in symbols:
                row=observed.get(symbol)
                indices.append({'symbol':symbol,'name':'纳斯达克综合指数' if symbol=='usIXIC' else row['name'] if row else symbol,
                    'open':row['open'] if row else None,'latest':row['price'] if row else None,'changePct':row['changePct'] if row else None,
                    'time':row['time'] if row else '', 'kind':'index','proxy':False})
            groups.append({'market':region,'label':label,'flag':flag,'open':None,'indices':indices})
        complete=len(observed)==6;extra={'sessionOpenKnown':False,'fearGreedSourceSeparate':True}
    elif target.source=='cnn' and kind=='indices':
        data=document(raw).get('fear_and_greed',{});score=numeric(data.get('score'));previous=numeric(data.get('previous_close'))
        if score is None or not 0<=score<=100:raise ValueError('fear_greed_score_invalid')
        rating=str(data.get('rating',''));labels={'extreme fear':'极度恐惧','fear':'恐惧','neutral':'中性','greed':'贪婪','extreme greed':'极度贪婪'}
        groups=[{'market':'F&G','label':'恐惧与贪婪指数','flag':'🧠','open':None,'indices':[{'name':'恐惧与贪婪指数',
            'open':previous,'latest':math.floor(score*10+0.5)/10,'changePct':(score-previous)/previous*100 if previous else None,
            'time':str(data.get('timestamp','')),'extra':labels.get(rating.lower(),rating),'kind':'sentiment','proxy':False}]}];complete=True
    elif target.source=='eastmoney':
        data=document(raw).get('data');rows=data.get('diff') if isinstance(data,dict) else None
        if not isinstance(rows,list):raise ValueError('eastmoney_diff_invalid')
        total=data.get('total');seen=set();dates=set();previous=Decimal('Infinity')
        if total is not None and type(total) is not int or not rows:raise ValueError('eastmoney_total_or_rows_invalid')
        ranking=kind=='ranking';metric=value.get('metric');field='f20' if kind=='top' else 'f5' if metric=='volume' else 'f6'
        if ranking and (len(rows)!=10 or not isinstance(total,(int,Decimal)) or total<10):raise ValueError('incomplete_market_ranking')
        for row in rows[:100]:
            code=row.get('f12');name=row.get('f14');rank=numeric(row.get(field),positive=True)
            if not isinstance(code,str) or not re.fullmatch(r'[A-Z0-9.\-]{1,24}',code,re.IGNORECASE) or not isinstance(name,str) or not name.strip() or code in seen or rank is None or Decimal(str(rank))>previous:raise ValueError('ranking_identity_order_or_value_invalid')
            seen.add(code);previous=Decimal(str(rank));item={'market':market,'code':code.upper(),'name':name.strip(),'price':numeric(row.get('f2'),positive=True),'changePct':numeric(row.get('f3'))}
            if ranking:
                stamp=numeric(row.get('f124'),positive=True)
                if stamp is None or not now-timedelta(days=10)<=datetime.fromtimestamp(stamp,UTC)<=now+timedelta(minutes=3):raise ValueError('ranking_timestamp_invalid')
                at=datetime.fromtimestamp(stamp,UTC);dates.add(at.astimezone(ZoneInfo('America/New_York' if market=='US' else 'Asia/Shanghai')).date().isoformat())
                item.update({metric:rank,'time':at.isoformat()})
            else:item.update(marketCap=rank,logo='',type='stock',rankChange=None)
            items.append(item)
        if ranking and len(dates)!=1:raise ValueError('mixed_ranking_dates')
        if ranking:extra={'tradeDate':next(iter(dates)),'currency':CURRENCIES[market] if metric=='amount' else None}
        complete=len(items)==min(100,total) if kind=='top' and type(total) is int else ranking
    elif target.source=='tradingview':
        data=document(raw);rows=data.get('data');total=data.get('totalCount');metric=value['metric']
        if type(total) is not int or not isinstance(rows,list) or total<10 or total>20000 or len(rows)!=(10 if metric=='volume' else total):raise ValueError('scanner_universe_incomplete')
        dates=set();seen=set();previous=Decimal('Infinity');candidates=[]
        for entry in rows:
            fields=entry.get('d')
            if not isinstance(fields,list) or len(fields)!=(6 if metric=='volume' else 8):raise ValueError('scanner_row_invalid')
            if metric=='volume':code,name,volume,day,type_,exchange=fields;high=None;currency=CURRENCIES[market]
            else:code,name,high,volume,day,type_,exchange,currency=fields
            if (not isinstance(code,str) or not isinstance(name,str) or not name.strip() or type_!='stock' or exchange not in EXCHANGES[market]
                or entry.get('s')!=exchange+':'+code or currency!=CURRENCIES[market]):raise ValueError('scanner_identity_invalid')
            normalized=code.zfill(5) if market=='HK' else code.upper()
            if not re.fullmatch(r'[A-Z0-9.\-]{1,24}',normalized) or normalized in seen or market=='HK' and not re.fullmatch(r'[0-9]{5}',normalized) or market=='CN' and not re.fullmatch(r'[0-9]{6}',normalized):raise ValueError('scanner_code_invalid')
            seen.add(normalized);v=numeric(volume)
            if metric=='amount' and (volume is None or v==0):continue
            stamp=numeric(day,positive=True)
            if v is None or v<=0 or stamp is None or stamp%86400 or datetime.fromtimestamp(stamp,UTC)>now+timedelta(minutes=3):raise ValueError('scanner_observation_invalid')
            date=datetime.fromtimestamp(stamp,UTC).date().isoformat();dates.add(date)
            if metric=='volume':
                if Decimal(str(v))>previous or datetime.fromtimestamp(stamp,UTC)<now-timedelta(days=10):raise ValueError('scanner_rank_or_date_invalid')
                previous=Decimal(str(v));items.append({'market':market,'code':normalized,'name':name.strip(),'volume':v})
            else:
                h=numeric(high,positive=True)
                if h is None:raise ValueError('scanner_high_invalid')
                candidates.append({'market':market,'code':normalized,'name':name.strip(),'upper':amount_bound(high,volume),'date':date})
        if metric=='volume' and len(dates)!=1:raise ValueError('scanner_mixed_dates')
        if metric=='amount':
            latest=max(dates) if dates else None
            candidates=sorted((row for row in candidates if row['date']==latest),key=lambda row:Decimal(row['upper']),reverse=True)
            if latest is None or len(candidates)<10 or datetime.fromisoformat(latest).replace(tzinfo=UTC)<now-timedelta(days=10):raise ValueError('amount_universe_invalid')
            extra={'candidates':candidates,'tradeDate':latest,'currency':CURRENCIES[market]};complete=False
        else:extra={'tradeDate':next(iter(dates))};complete=True
    elif target.source=='companiesmarketcap':
        text=raw.decode('utf-8');rows=re.findall(r'<tr[^>]*>[\s\S]*?</tr>',text)
        for row in rows:
            name=re.search(r'company-name">([^<]*)<',row);symbol=re.search(r'company-code"><span class="rank d-none"></span>([^<]*)<',row)
            if not name or not symbol:continue
            code=html.unescape(symbol[1]).strip();name=html.unescape(name[1]).strip();type_='crypto' if re.search(r'<tr class="[^"]*crypto',row) else 'metal' if re.search(r'<tr class="[^"]*precious',row) else 'stock'
            if market=='ALL':
                cells=re.findall(r'<td[^>]*>[\s\S]*?</td>',row)
                values=[re.search(r'data-sort="([-\d.]+)"',cell) for cell in cells[2:5]]
                if len(values)!=3 or not values[0]:continue
                cap=numeric(values[0][1],positive=True);price=numeric(values[1][1]) if values[1] else None;pct=numeric(values[2][1]) if values[2] else None
                price=price/100 if price is not None else None;pct=pct/100 if pct is not None else None
                region='ASSET' if type_!='stock' else next((m for suffix,m in (('.HK','HK'),('.SS','CN'),('.SZ','CN'),('.T','JP'),('.KS','KR'),('.KQ','KR')) if code.upper().endswith(suffix)), 'US' if re.fullmatch(r'[A-Z0-9\-]+',code.upper()) else None)
            else:
                c=re.search(r'class="td-right" data-sort="(\d+)"><span class="currency-symbol-left">',row);p=re.search(r'data-sort="\d+">\$([\d,.]+)</td>',row);change=re.search(r'([\d.]+)%</span>',row)
                cap=numeric(c[1],positive=True) if c else None;price=numeric(p[1].replace(',','')) if p else None;pct=numeric(change[1]) if change else None;region=market
            if cap is None:continue
            items.append({'market':region,'code':code,'name':name,'marketCap':cap,'price':price,'changePct':pct,'type':type_,'logo':'','rankChange':None})
            if len(items)==100:break
        if not items:raise ValueError('cmc_ranking_unavailable')
        if any(items[index]['marketCap']>items[index-1]['marketCap'] for index in range(1,len(items))):raise ValueError('cmc_rank_order_invalid')
        complete=len(items)==100 and all(row['market'] is not None for row in items);extra={'marketCapCurrency':'USD','providerWindowComplete':len(items)==100,'securityIdentityKnown':all(row['market'] is not None for row in items)}
    else:raise ValueError('discovery_parser_not_installed')
    result={'items':items,'groups':groups,'updatedAt':iso(now),'coverage':{'scope':'provider_query_response' if kind=='search' else 'provider_market_top' if kind in ('ranking','top') else 'declared_index_set',
        'complete':complete,'providerTotal':total,'observedCount':len(items) if groups is None else sum(len(group['indices']) for group in groups)},**extra}
    json.dumps(result,ensure_ascii=False,allow_nan=False).encode('utf-8')
    return result
