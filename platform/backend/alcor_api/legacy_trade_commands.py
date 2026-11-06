"""Strict old numeric requests, mapped once into native actual ledger operations."""
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext

from fastapi import HTTPException

from .actual_fee_confirmations import identifier, valid_text
from .current_fees import parse_input as native_fee_input
from .fee_repairs import hashed


def number(value,*,zero=False):
    if type(value) not in (int,float,Decimal):raise HTTPException(400,'替换金额须为数值')
    try:
        amount=Decimal(str(value))
        with localcontext() as precision:
            precision.prec=80
            amount=amount.normalize()
        if not amount.is_finite() or amount<0 or not zero and amount==0 or amount>Decimal('1e12') or amount.as_tuple().exponent < -8:raise InvalidOperation()
        return format(amount,'f')
    except InvalidOperation:raise HTTPException(400,'金额须在原八位小数与范围内') from None


def timestamp(value):
    try:
        if not isinstance(value,str) or not 20<=len(value)<=50:raise ValueError()
        when=datetime.fromisoformat(value)
        if when.tzinfo is None:raise ValueError()
        return value
    except ValueError:raise HTTPException(400,'成交时间须包含可核对时区') from None


def version_hash(value):
    if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):raise HTTPException(400,'快照版本无效')
    return value


def revision(value):
    if type(value) is not int or not 1<=value<=9007199254740991:raise HTTPException(400,'记录或订单版本无效')
    return value


def fee_input(value):
    if value is None:raise HTTPException(400,'费用来源不能为null')
    if not isinstance(value,dict):raise HTTPException(400,'费用参数无效')
    if value.get('source')=='rule_calculated':raise HTTPException(409,'规则计算费用尚未独立核实实付，不能用于实际金融更正')
    if value.get('providerId') not in ('longbridge','huatai') or not isinstance(value.get('brokerAccountId'),str) or not value['brokerAccountId'].startswith('ba-'):raise HTTPException(400,'费用账户或供应商无效')
    converted=dict(value)
    if 'components' in converted:
        if not isinstance(converted['components'],list):raise HTTPException(400,'费用分项无效')
        converted['components']=[{**part,'amount':number(part.get('amount'),zero=True)} if isinstance(part,dict) else part for part in converted['components']]
    try:native_fee_input(converted)
    except (ValueError,TypeError,KeyError):raise HTTPException(400,'原账户费用来源或分项参数无效') from None
    return converted


def registration(raw):
    fields={'requestId','accountId','recordId','recordRevision','snapshotRevision','side','mode','orderType','qty','price','fees','tif','session','tradedAt','note','feeInput','allowFinancing','settlementAmount','attachments','buyTarget','targetRevision','expiresAt','triggerPrice'}
    required=fields-{'requestId','note','feeInput','allowFinancing','settlementAmount','attachments','buyTarget','targetRevision','expiresAt','triggerPrice'}
    if isinstance(raw,dict) and 'buyTarget' in raw:required-= {'recordId','recordRevision'}
    if not isinstance(raw,dict) or set(raw)-fields or not required<=set(raw):raise HTTPException(400,'旧成交登记参数无效')
    if not valid_text(raw['accountId'],200) or 'buyTarget' not in raw and not valid_text(raw['recordId'],200):raise HTTPException(400,'本人账户或证券无效')
    if raw['mode']!='record' or raw['side'] not in ('buy','sell','dividend') or raw['orderType'] not in ('market','limit','trigger_buy','trigger_sell','rebound_buy','rebound_sell') or raw['tif'] not in ('day','gtc','custom') or raw['session'] not in ('REGULAR','EXTENDED'):raise HTTPException(409,'实际登记须明确发生时间与股票买卖或股息到账')
    if raw.get('expiresAt') is not None:
        try:
            expiry=datetime.fromisoformat(raw['expiresAt'])
            if expiry.tzinfo is None and len(raw['expiresAt'])!=10:raise ValueError
        except (ValueError,TypeError,AttributeError) as error:
            raise HTTPException(400,'历史有效期须为日期或带时区时间') from error
    if raw.get('triggerPrice') is not None:number(raw['triggerPrice'])
    if 'allowFinancing' in raw and (raw['allowFinancing'] is not True or raw['side']!='buy'):raise HTTPException(400,'融资确认仅用于已成交买入')
    from .internal_order_families import attachments
    parsed_attachments=attachments(raw.get('attachments'))
    if raw['side']=='dividend' and parsed_attachments:
        raise HTTPException(400,'股息到账不接受附加单')
    if 'buyTarget' in raw and (raw['side']!='buy' or 'recordId' in raw or 'recordRevision' in raw):
        raise HTTPException(400,'买入目标不能与原记录混用')
    note=raw.get('note','')
    if not isinstance(note,str) or len(note)>500 or any(ord(c)<32 or ord(c)==127 for c in note):raise HTTPException(400,'备注无效')
    return {**raw,'requestId':identifier(raw['requestId']) if raw.get('requestId') is not None else None,
      'recordRevision':revision(raw['recordRevision']) if 'buyTarget' not in raw else None,'snapshotRevision':version_hash(raw['snapshotRevision']),
      'qty':number(raw['qty']),'price':number(raw['price']),'fees':number(raw['fees'],zero=True),
      'tradedAt':timestamp(raw['tradedAt']),'note':note,**({'triggerPrice':number(raw['triggerPrice']) if raw['triggerPrice'] is not None else None} if 'triggerPrice' in raw else {}),**({'settlementAmount':number(raw['settlementAmount'])} if 'settlementAmount' in raw else {}),**({'attachments':parsed_attachments} if parsed_attachments else {}),**({'feeInput':fee_input(raw['feeInput'])} if 'feeInput' in raw else {})}


def registration_fingerprint(data):
    return hashed({key:value for key,value in data.items() if key not in ('requestId','targetRevision')})


def correction(raw):
    fields={'requestId','accountId','snapshotRevision','recordId','recordRevision','action','orders','replacement','timeSourceOrderId','financingConfirmation'}
    required={'requestId','accountId','snapshotRevision','recordId','recordRevision','action','orders'}
    if not isinstance(raw,dict) or set(raw)-fields or not required<=set(raw):raise HTTPException(400,'旧成交更正参数无效')
    if not valid_text(raw['accountId'],200) or not valid_text(raw['recordId'],200):raise HTTPException(400,'本人账户或证券无效')
    if raw['action'] not in ('amend','merge','delete') or not isinstance(raw['orders'],list) or not 1<=len(raw['orders'])<=100:raise HTTPException(400,'更正动作或原单范围无效')
    orders=[];seen=set()
    for item in raw['orders']:
        if not isinstance(item,dict) or set(item)!={'id','revision'} or not valid_text(item['id'],200) or item['id'] in seen:raise HTTPException(400,'原订单选择重复或无效')
        orders.append({'id':item['id'],'revision':revision(item['revision'])});seen.add(item['id'])
    if raw['action']=='merge' and len(orders)<2 or raw['action']!='merge' and len(orders)!=1:raise HTTPException(400,'更正原单数量不符')
    data={**raw,'requestId':identifier(raw['requestId']),'recordRevision':revision(raw['recordRevision']),'snapshotRevision':version_hash(raw['snapshotRevision']),'orders':orders}
    if 'financingConfirmation' in raw:
        from .financing_model import confirmation
        data['financingConfirmation']=confirmation(raw['financingConfirmation'])
    if raw['action']=='delete':
        if 'replacement' in raw or 'timeSourceOrderId' in raw:raise HTTPException(400,'删除不接受替换参数')
        return data
    replacement=raw.get('replacement')
    if not isinstance(replacement,dict) or set(replacement)-{'qty','price','fees','tradedAt','feeInput'} or not {'qty','price','fees','tradedAt'}<=set(replacement):raise HTTPException(400,'须明确原替换成交及实付费用')
    data['replacement']={**replacement,'qty':number(replacement['qty']),'price':number(replacement['price']),'fees':number(replacement['fees'],zero=True),'tradedAt':timestamp(replacement['tradedAt']),**({'feeInput':fee_input(replacement['feeInput'])} if 'feeInput' in replacement else {})}
    if raw['action']=='amend' and 'timeSourceOrderId' in raw or raw['action']=='merge' and raw.get('timeSourceOrderId') not in seen:raise HTTPException(400,'合并须明确采用哪一原单时间')
    return data
