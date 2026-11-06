"""Exact decimal commands and deterministic absolute-adjustment replay for manual card records."""

import hashlib
import json
import re
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException

from .card_catalog_contract import clean
from .card_preferences import card_key, js_text, sqlite_text
from .cash_ledger import add
from .trade_accounting import AccountingError, number

LIMIT = Decimal(1000000000000)


def hashed(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def money(value, negative=True):
    try:
        value = number(value, negative=negative)
        if value.copy_abs() > LIMIT:
            raise ValueError()
        return value
    except (AccountingError, ValueError):
        raise HTTPException(422, '金额无效，需使用精确十进制数') from None


def command(raw):
    allowed = {'requestId','expectedRevision','operation','cardKey','amount','currency','note','occurredAt','entryId','allowNegativeBalance','fundAccount','accountId','accountKind','accountRevision','cashRevision'}
    if not isinstance(raw, dict) or set(raw) - allowed:
        raise HTTPException(422, '卡包金额字段无效')
    try:
        request = str(UUID(raw['requestId']))
        if request != raw['requestId'] or type(raw['expectedRevision']) is not int or not 0 <= raw['expectedRevision'] < 9007199254740991:
            raise ValueError()
        operation = raw['operation']
        if operation not in ('set_amount','clear_amount','deposit','withdraw','adjust','delete_entry'):
            raise ValueError()
        when = datetime.fromisoformat(raw['occurredAt'])
        if when.tzinfo is None:
            raise ValueError()
        currency = raw.get('currency')
        if currency is not None and (not isinstance(currency, str) or not re.fullmatch('[A-Z]{3}', currency)):
            raise ValueError()
        note = raw.get('note', '')
        if not isinstance(note,str) or len(note)>500 or '\x00' in note:
            raise ValueError()
        if 'allowNegativeBalance' in raw and type(raw['allowNegativeBalance']) is not bool:
            raise ValueError()
        linked=raw.get('fundAccount')=='broker'
        if raw.get('fundAccount') not in (None,'','broker'):raise ValueError()
        if linked and operation not in ('deposit','withdraw'):raise HTTPException(422,'只有存入或取出可明确联动券商现金')
        if linked:
            if not isinstance(raw.get('accountId'),str) or not 1<=len(raw['accountId'])<=100 or raw.get('accountKind') not in ('real','simulated'):raise HTTPException(409,'联动须明确本人券商账户及真实或模拟账本，不能自动选择')
            if any(type(raw.get(key)) is not int or raw[key]<0 for key in ('accountRevision','cashRevision')):raise HTTPException(409,'请读取当前券商及现金版本后确认联动')
        elif any(key in raw for key in ('accountId','accountKind','accountRevision','cashRevision')):raise HTTPException(422,'未选择券商联动时不能提交另一端账户')
        key = card_key(raw['cardKey'])
        amount = money(raw['amount'], negative=operation=='adjust') if operation in ('set_amount','deposit','withdraw','adjust') else None
        entry = str(UUID(raw['entryId'])) if operation=='delete_entry' else None
    except (KeyError, ValueError, TypeError, AttributeError):
        raise HTTPException(422, '卡包金额参数无效') from None
    return {'requestId':request,'expectedRevision':raw['expectedRevision'],'operation':operation,'cardKey':key,
            'amount':str(amount) if amount is not None else None,'currency':currency,'note':note,
            'occurredAt':when.astimezone(UTC).isoformat(),'entryId':entry,
            'allowNegativeBalance':raw.get('allowNegativeBalance',False),**({key:raw[key] for key in ('fundAccount','accountId','accountKind','accountRevision','cashRevision')} if linked else {})}


def replay(rows, opening):
    balance = opening
    projected = []
    for row in sorted(rows, key=lambda item:(item['occurred_at'],item['order_id'])):
        before = balance
        if row['kind']=='adjust':
            balance = row['target_amount']
        else:
            if balance is None:
                raise HTTPException(409, '期初余额未知，请先核对金额或登记绝对余额调整')
            balance = add(balance, row['original_amount'] if row['kind']=='deposit' else row['original_amount'].copy_negate())
        if balance is None or balance.copy_abs()>LIMIT:
            raise HTTPException(409, '重放后的金额超出范围')
        delta = add(balance,before.copy_negate()) if before is not None else None
        projected.append(dict(row, delta=delta, balance=balance))
    return balance, projected


def details_patch(raw, *, legacy=False):
    fields={'number','expiry','cvv','note','currency','currencyScope','image'}
    if not isinstance(raw,dict) or not legacy and set(raw)-fields:
        raise HTTPException(400, '卡背信息字段无效')
    patch={}
    for key in fields & set(raw):
        value = ('null' if raw[key] is None else js_text(raw[key])) if legacy else raw[key]
        if not isinstance(value,str):
            raise HTTPException(400, '卡背信息字段需为文字')
        if key=='number':
            value=re.sub('[^0-9 ]','',value)
            if len(value)>30:
                raise HTTPException(400,'卡号过长')
            value=re.sub(r'\s+',' ',value)[:30].strip()
        elif key=='expiry':
            value=re.sub('[^0-9/]','',value)[:7]
        elif key=='cvv':
            value=re.sub('[^0-9]','',value)[:4]
        elif key=='note':
            if len(value.encode('utf-16-le',errors='surrogatepass'))//2>60:
                raise HTTPException(400,'备注过长')
            value=sqlite_text(clean(value,60))
        elif key=='currency':
            value=re.sub('[^A-Z]','',value.upper())[:8]
        elif key=='currencyScope':
            value=clean(value,100).lower()
            value=value if value in ('single','dual','multi','unknown') else ''
        elif key=='image':
            value=clean(value,1000)
            if value and (not value.startswith('/uploads/') or len(value.encode('utf-16-le',errors='surrogatepass'))//2>500):
                raise HTTPException(400,'卡面地址无效')
            value=sqlite_text(value)
        patch[key]=value
    return patch
