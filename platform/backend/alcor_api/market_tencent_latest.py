"""Original Tencent one-symbol GBK quote protocol over an explicitly licensed target.

An unzoned source clock stays unknown unless the installed policy explicitly
states its timezone; receipt time is never promoted to quote time.
"""
import re
from datetime import UTC,datetime
from decimal import Decimal,InvalidOperation
from zoneinfo import ZoneInfo

from .dividend_source_transport import fetch_page
from .market_contract import CURRENCIES,number

VERSION='tencent-quotes-v1'
MARKETS=('US','HK','CN','JP','KR')


def symbol(market,code):
    if not isinstance(code,str):raise ValueError('tencent_code_invalid')
    raw=code.strip().upper()
    if not re.fullmatch(r'[A-Z0-9._]+',raw):raise ValueError('tencent_code_invalid')
    if market=='US':return 'us'+re.sub(r'\.(OQ|N|AM|PS|K)$','',raw)
    if market=='HK'and raw.isdigit()and len(raw)<=5:return 'hk'+raw.lstrip('0').zfill(5)
    if market=='CN'and raw.isdigit()and len(raw)<=6:
        raw=raw.zfill(6)
        return ('bj'if raw.startswith(('4','8','920'))else'sh'if raw.startswith(('6','9'))else'sz'if raw.startswith(('0','1','2','3'))else'bj')+raw
    if market=='JP':return 'jp'+re.sub(r'\.T$','',raw)
    if market=='KR':return 'kr'+re.sub(r'\.(KS|KQ)$','',raw)
    raise ValueError('tencent_market_invalid')


def installed(query):
    try:code=symbol(query.market,query.code)
    except ValueError:return False
    return bool(code and query.kind=='latest'and query.instrument=='equity'and query.frame=='latest'and query.adjust=='none'and query.session=='REGULAR')


async def fetch(target,query,cursor):
    if not installed(query)or cursor is not None or target.source!='tencent'or target.host!='qt.gtimg.cn'or target.scheme!='https'or target.port!=443 or target.fixture:raise ValueError('tencent_fixed_target_required')
    code=symbol(query.market,query.code)
    return await fetch_page('https://qt.gtimg.cn/q='+code,target.approval(code)),'http_response_body_gbk'


def observation(raw,query):
    if not installed(query)or not isinstance(raw,bytes)or not 0<len(raw)<=131072:raise ValueError('tencent_reply_invalid')
    text=raw.decode('gbk',errors='strict')
    matches=re.findall(r'v_([^=\s]+)="([^"]*)"',text)
    if len(matches)!=1 or matches[0][0]!=symbol(query.market,query.code):raise ValueError('tencent_security_mismatch')
    fields=matches[0][1].split('~')
    if len(fields)<35:raise ValueError('tencent_fields_incomplete')
    def value(index,*,signed=False,positive=False):
        if index>=len(fields)or not fields[index].strip():return None
        try:return str(number(fields[index],signed=signed,positive=positive))
        except (ValueError,TypeError,InvalidOperation):return None
    price=value(3,positive=True)
    if price is None:raise ValueError('tencent_price_unknown')
    result={'price':price,'name':fields[1]or query.code,'sourceSymbol':matches[0][0],'sourceClock':fields[30]or None,
        'currency':CURRENCIES[query.market],'session':'UNKNOWN','requestedSession':'REGULAR','cached':None,'providerCacheState':'unknown',
        'volumeUnit':'provider_native_shares_or_lots_not_normalized','source':'tencent','sourceVersion':VERSION,'instrument':'equity',
        'priceNumberAuthority':'provider_gbk_decimal_text','sourceTimestampAuthority':'provider_clock_requires_explicit_timezone',
        'equityValid':False,'fundValid':False}
    for index,key,signed,positive in [(4,'prevClose',False,True),(5,'open',False,True),(31,'change',True,False),(32,'changePct',True,False),(33,'high',False,True),(34,'low',False,True),(36,'volume',False,False),(37,'amount',False,False),(38,'turnover',False,False),(39,'pe',True,False),(43,'amplitude',False,False),(47,'epsTtm',True,False),(48,'weekHigh',False,True),(49,'weekLow',False,True),(51,'pb',True,False),(52,'dividendYieldTtm',False,False),(55,'volumeRatio',False,False),(62,'totalShares',False,False),(63,'floatShares',False,False),(65,'staticPe',True,False),(66,'dividendTtm',True,False),(67,'averagePrice',False,True)]:
        actual=value(index,signed=signed,positive=positive)
        if actual is not None:result[key]=actual
    cap=value(44,positive=True)
    if cap is not None:result.update(marketCap=str(Decimal(cap)*Decimal(100000000)),marketCapCurrency=CURRENCIES[query.market],marketCapBasis='provider_f44_times_1e8')
    # Original non-JP/KR placeholder rejection, without filling absent metrics as zero.
    if query.market not in ('JP','KR')and all(key in result and Decimal(result[key])==0 for key in ('volume','change','changePct','amount')):raise ValueError('tencent_placeholder_quote')
    return result


def parse(raw,query,policy):
    result=observation(raw,query);clock=result['sourceClock'];at=None
    if clock:
        try:
            candidate=datetime.strptime(clock,'%Y%m%d%H%M%S')if re.fullmatch(r'[0-9]{14}',clock)else datetime.strptime(clock,'%Y/%m/%d %H:%M:%S') if re.fullmatch(r'[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}',clock) else datetime.fromisoformat(clock)
            if candidate.tzinfo is None:
                zones=dict(getattr(policy,'timestamp_zones',()))
                if query.market in zones:
                    zoned=candidate.replace(tzinfo=ZoneInfo(zones[query.market]))
                    if zoned.utcoffset()!=zoned.replace(fold=1).utcoffset()or zoned.astimezone(UTC).astimezone(zoned.tzinfo).replace(tzinfo=None)!=candidate:raise ValueError('provider_local_clock_ambiguous')
                    candidate=zoned
            if candidate.tzinfo is not None:at=candidate.astimezone(UTC).isoformat()
        except (ValueError,TypeError):pass
    if at is None:return [],[{'reason':'source_timestamp_unknown','sourceClock':clock,'parsedPriceKnown':True,'publication':'original_retained_without_timestamped_fact'}],None
    result.update(at=at,marketTimezone=dict(getattr(policy,'timestamp_zones',())).get(query.market,'source_explicit_offset'),sourceTimestampAuthority='provider_clock_explicit_timezone')
    return [result],[],None
