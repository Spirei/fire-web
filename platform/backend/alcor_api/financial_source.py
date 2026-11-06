"""A bounded normalized export contract, retaining exact source bytes independently.

This is not an exporter and never claims an unknown old database is authoritative.
Every cash row is a source posting; no cash delta is manufactured by replaying fills.
"""

import base64
import hashlib
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from uuid import UUID

from fastapi import HTTPException

from alcor_api.trade_accounting import AccountingError, number


def fail(message):
    raise HTTPException(422, message)


def text(value, *, nullable=False, limit=200):
    if value is None and nullable:
        return value
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(c)<32 or ord(c)==127 for c in value):
        fail('原账身份或文本无效')
    return value


def shape(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        fail('原账结构版本或字段不匹配')


def array(value, maximum=100000):
    if not isinstance(value, list) or len(value)>maximum:
        fail('原账集合超出范围')
    return value


def decimal(value, *, negative=False):
    if value is None:
        return None
    # Original decimals must arrive as strings, never binary floating point.
    if not isinstance(value, str):
        fail('原账金额必须保留十进制原串')
    try:
        return number(value, negative=negative)
    except AccountingError as exc:
        fail(str(exc))


def timestamp(value, timezone):
    if value is None:
        return None
    text(value)
    try:
        when = datetime.fromisoformat(value)
        if when.tzinfo is None:
            return None
        # UTC-serialized instants and the source's IANA calendar are separate
        # facts. Preserve both; never rewrite an original UTC string into local time.
        if timezone:ZoneInfo(timezone)
        return when
    except (ValueError, ZoneInfoNotFoundError):
        fail('原账时间或时区无效')


def unique(rows):
    keys = [text(row.get('id')) for row in rows if isinstance(row, dict)]
    if len(keys)!=len(rows) or len(keys)!=len(set(keys)):
        fail('原账原始编号重复')


def parse_source(raw):
    if not 0 < len(raw) <= 16*1024*1024:
        fail('原账快照超出范围')
    def pairs(items):
        output={}
        for key,value in items:
            if key in output:
                fail('原账JSON含重复字段')
            output[key]=value
        return output
    try:
        data=json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _:fail('原账数值无效'))
    except (UnicodeDecodeError, ValueError, RecursionError):
        fail('原账快照必须为有效UTF-8 JSON')
    shape(data,'format source evidence records cashScopes cash orders')
    if data['format']!='legacy-financial/1':
        fail('原账格式版本不受支持')
    meta=data['source']
    shape(meta,'instance owner version timezone complete authority cashScopeSemantics')
    for key in ('instance','owner','version'):
        text(meta[key])
    text(meta['timezone'],nullable=True)
    if meta['timezone']:
        try: ZoneInfo(meta['timezone'])
        except (ZoneInfoNotFoundError,ValueError): fail('原账IANA时区无效')
    if type(meta['complete']) is not bool:
        fail('原账完整性标记无效')
    if meta['authority'] not in ('frozen_authoritative_export','unknown'):
        fail('原账权威类型无效')
    if meta['cashScopeSemantics'] not in ('owner_total_includes_allocations','unknown'):
        fail('原现金范围口径无效')
    evidence=array(data['evidence'],10000)
    unique(evidence)
    for item in evidence:
        shape(item,'id kind sha256 rawBase64')
        text(item['kind'])
        try: content=base64.b64decode(item['rawBase64'],validate=True)
        except (ValueError,TypeError): fail('原账证据字节无效')
        if len(content)>262144 or hashlib.sha256(content).hexdigest()!=item['sha256']:
            fail('原账证据哈希不匹配')
    evidence_ids={item['id'] for item in evidence}
    def proof(value):
        if value is not None and value not in evidence_ids: fail('原账引用的证据缺失')
    def money_keys(item, keys):
        for key in keys.split(): decimal(item[key],negative=key in ('cost','amount','ownerTotal','unallocated'))
    def identity(item):
        text(item['version']);text(item['originalBrokerAccountId'],nullable=True)
        text(item['sourceOwner'])
        if item['sourceOwner']!=meta['owner']:fail('原账行owner与已确认源owner不一致')
        if item['accountKind'] not in ('real','simulated','unknown'): fail('原账真实模拟身份无效')
    records=array(data['records']);unique(records)
    for item in records:
        shape(item,'id version sourceOwner code market accountMarket accountKind originalBrokerAccountId opening closing')
        identity(item);text(item['code']);text(item['market'])
        if not isinstance(item['accountMarket'],str):fail('原证券账户市场无效')
        shape(item['opening'],'quantity cost occurredAt evidenceId')
        shape(item['closing'],'quantity cost evidenceId')
        for part in ('opening','closing'):
            decimal(item[part]['quantity']);decimal(item[part]['cost'],negative=True);proof(item[part]['evidenceId'])
        timestamp(item['opening']['occurredAt'],meta['timezone'])
    scopes=array(data['cashScopes'],100)
    scope_keys=[]
    for item in scopes:
        shape(item,'accountKind currency complete ownerTotal unallocated accounts evidenceId')
        if item['accountKind'] not in ('real','simulated','unknown') or type(item['complete']) is not bool:fail('原现金范围无效')
        if not re.fullmatch('[A-Z]{3}',str(item['currency'])):fail('原币种无效')
        money_keys(item,'ownerTotal unallocated');proof(item['evidenceId'])
        scope_keys.append((item['accountKind'],item['currency']))
        ids=[]
        for balance in array(item['accounts'],10000):
            shape(balance,'sourceAccountId amount');ids.append(text(balance['sourceAccountId']));decimal(balance['amount'],negative=True)
        if len(ids)!=len(set(ids)):fail('原账户余额重复')
    if len(scope_keys)!=len(set(scope_keys)):fail('原现金范围重复')
    cash=array(data['cash']);unique(cash)
    for item in cash:
        shape(item,'id version sourceOwner requestId sourceAccountId originalBrokerAccountId originalScope accountKind currency kind amount affectsOwner occurredAt orderId evidenceId')
        identity(item);text(item['sourceAccountId'],nullable=True);text(item['orderId'],nullable=True)
        if item['requestId'] is not None:
            try: UUID(item['requestId'])
            except (ValueError,TypeError,AttributeError):fail('原现金UUID无效')
        if item['originalScope'] not in ('broker','unallocated','unknown'):fail('原现金归属范围无效')
        if item['kind'] not in ('opening','allocation','external_deposit','external_withdrawal','reconcile_balance','trade_buy','trade_sell','trade_dividend'):fail('原现金流水种类无效')
        if not re.fullmatch('[A-Z]{3}',str(item['currency'])) or type(item['affectsOwner']) is not bool:fail('原现金字段无效')
        decimal(item['amount'],negative=True);timestamp(item['occurredAt'],meta['timezone']);proof(item['evidenceId'])
    orders=array(data['orders']);unique(orders)
    for item in orders:
        shape(item,'id version sourceOwner requestId recordId sourceAccountId originalBrokerAccountId accountKind status fillAuthority feeAuthority feeEvidenceId side quantity price amount fees currency settlementCurrency settlementAmount occurredAt cancelledAt cashId evidenceId intent')
        identity(item);text(item['recordId']);text(item['sourceAccountId'],nullable=True);text(item['cashId'],nullable=True)
        if item['requestId'] is not None:
            try: UUID(item['requestId'])
            except (ValueError,TypeError,AttributeError):fail('原订单UUID无效')
        if item['status'] not in ('filled','pending','cancelled','canceled','expired','rejected','unknown') or item['side'] not in ('buy','sell','dividend'):
            fail('原订单状态或方向无效')
        if item['fillAuthority'] not in ('owner_recorded_history','broker_reported','not_filled','unknown') or item['feeAuthority'] not in ('owner_recorded','broker_reported','unverified_legacy','unknown'):
            fail('原成交或费用依据无效')
        for key in ('quantity','price','amount','fees','settlementAmount'):decimal(item[key])
        for key in ('currency','settlementCurrency'):
            if item[key] is not None and not re.fullmatch('[A-Z]{3}',str(item[key])):fail('原结算币种无效')
        timestamp(item['occurredAt'],meta['timezone']);timestamp(item['cancelledAt'],meta['timezone']);proof(item['evidenceId']);proof(item['feeEvidenceId'])
        if item['intent'] is not None:
            shape(item['intent'],'orderType tif expiresAt triggerPrice session triggerStatus parentId role executionContract')
            for key in ('orderType','tif','session','triggerStatus','parentId','role','executionContract'):
                if item['intent'][key] is not None and (not isinstance(item['intent'][key],str) or len(item['intent'][key])>200):fail('原意图条件无效')
            decimal(item['intent']['triggerPrice']);timestamp(item['intent']['expiresAt'],meta['timezone'])
    return data
