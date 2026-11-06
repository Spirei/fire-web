"""Bounded offline IBKR Activity Flex parser; no network or account writes."""
import hashlib
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from xml.parsers import expat

from fastapi import HTTPException

MAX_BYTES = 8 * 1024 * 1024
EXCHANGES = {**dict.fromkeys(('NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS', 'ISLAND', 'NYSEARCA', 'NASDAQNMS'), 'US'),
             'SEHK': 'HK', **dict.fromkeys(('SEHKNTL', 'SEHKSZSE', 'SSE', 'SZSE'), 'CN')}
EVENTS = ('Trade', 'CashTransaction', 'CorporateAction', 'Transfer')


def invalid(message='不是有效的 IBKR Activity Flex XML 账单'):
    raise HTTPException(422, message)


def xml_tree(raw):
    if not isinstance(raw, bytes) or not raw:
        invalid()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, '账单超过 8MB')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeError:
        invalid('账单须为 UTF-8 XML')
    parser = expat.ParserCreate()
    stack, roots = [], []
    count = 0

    def forbidden(*args):
        invalid('账单不允许 DTD 或外部实体')

    def start(name, attrs):
        nonlocal count
        count += 1
        if count > 100000 or len(stack) >= 24:
            invalid('账单结构超过读取范围')
        node = {'name': name, 'attrs': dict(sorted(attrs.items())), 'children': []}
        (stack[-1]['children'] if stack else roots).append(node)
        stack.append(node)

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda _: stack.pop()
    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    try:
        parser.Parse(text, True)
    except expat.ExpatError:
        invalid()
    if len(roots) != 1 or roots[0]['name'] != 'FlexQueryResponse':
        invalid('需要 Activity Flex XML 报表')
    return roots[0]


def descendants(node, name):
    if node['name'] == name:
        yield node
    for child in node['children']:
        yield from descendants(child, name)


def date(value):
    if not isinstance(value, str):
        invalid('账单缺少日期')
    compact = value.replace('-', '')
    if not re.fullmatch(r'[0-9]{8}', compact):
        invalid('账单日期无效')
    try:
        parsed = datetime.strptime(compact, '%Y%m%d')
    except ValueError:
        invalid('账单日期无效')
    if parsed.strftime('%Y%m%d') != compact:
        invalid('账单日期无效')
    return compact


def number(value, field, *, negative=True):
    if not isinstance(value, str) or len(value) > 256 or not re.fullmatch(r'[-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?', value):
        invalid('账单缺少有效' + field)
    try:
        result = Decimal(value)
    except InvalidOperation:
        invalid('账单缺少有效' + field)
    if not result.is_finite() or result.copy_abs() > Decimal('1e15') or len(result.as_tuple().digits) > 64 or (not negative and result < 0):
        invalid('账单' + field + '超出范围')
    # Source numeric text is retained, never rounded through binary floats.
    return value


def parse_flex(raw, external_account):
    if not isinstance(external_account, str) or not re.fullmatch(r'[A-Za-z0-9-]{2,40}', external_account):
        invalid('外部账户编号无效')
    root = xml_tree(raw)
    statements = [n for n in descendants(root, 'FlexStatement') if n['attrs'].get('accountId') == external_account]
    if len(statements) != 1:
        invalid('报表账户不匹配或包含多个日期分段')
    statement = statements[0]
    begin, end = date(statement['attrs'].get('fromDate')), date(statement['attrs'].get('toDate'))
    if begin > end:
        invalid('报表日期范围无效')
    for kind in ('OpenPosition', 'FinancialInstrument', 'CashReportCurrency', *EVENTS):
        if any(n['attrs'].get('accountId') not in (None, '', external_account) for n in descendants(statement, kind)):
            invalid('账单记录账户不一致')
    if not any(n['name'] == 'OpenPositions' for n in statement['children']):
        invalid('请在 Flex 查询中启用 Open Positions 汇总')
    instruments = {}
    for n in descendants(statement, 'FinancialInstrument'):
        key = n['attrs'].get('conid')
        if key in instruments and instruments[key] != n['attrs']:
            invalid('证券身份元数据冲突')
        instruments[key] = n['attrs']
    positions, cash, events, warnings = [], [], [], []
    keys, currencies, event_ids = set(), set(), set()
    for node in descendants(statement, 'OpenPosition'):
        a = node['attrs']
        if a.get('levelOfDetail') != 'SUMMARY' or a.get('model'):
            invalid('持仓须为未按 Model 拆分的 SUMMARY 汇总')
        if a.get('assetCategory') != 'STK':
            invalid('当前仅支持股票及股票类 ETF 持仓')
        if date(a.get('reportDate')) != end:
            invalid('持仓日期须与报表结束日期一致')
        listing = a.get('listingExchange') or instruments.get(a.get('conid'), {}).get('listingExchange')
        market = EXCHANGES.get(listing)
        currency = {'US': 'USD', 'HK': 'HKD', 'CN': 'CNY'}.get(market)
        if not market or a.get('currency') not in ('USD', 'HKD', 'CNY', 'CNH') or a['currency'].replace('CNH', 'CNY') != currency:
            invalid('证券上市市场或币种不支持或不匹配')
        if not re.fullmatch(r'[0-9]+', a.get('conid', '')) or not a.get('symbol'):
            invalid('账单缺少证券身份')
        code = a['symbol'].zfill(5) if market == 'HK' else a['symbol'].upper()
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,40}', code):
            invalid('证券代码暂不支持')
        key = market + ':' + code
        if key in keys:
            invalid('报表包含重复持仓')
        keys.add(key)
        positions.append({'key': key, 'conid': a['conid'], 'code': code, 'name': (a.get('description') or code)[:100],
                          'market': market, 'currency': currency, 'sourceCurrency': a['currency'],
                          'qty': number(a.get('position'), '持仓数量', negative=False),
                          'price': number(a.get('markPrice'), '收盘价', negative=False),
                          'cost': number(a.get('costBasisPrice'), '每股成本')})
        if len(positions) > 2000:
            invalid('持仓数量超过 2000')
    for node in descendants(statement, 'CashReportCurrency'):
        a = node['attrs']; currency = a.get('currency', '')
        if currency == 'BASE_SUMMARY':
            continue
        if not re.fullmatch(r'[A-Z]{3}', currency) or currency in currencies:
            invalid('现金币种无效或存在重复汇总')
        currencies.add(currency)
        cash.append({'currency': currency, 'endingCash': number(a.get('endingCash'), '期末现金')})
    for kind in EVENTS:
        for node in descendants(statement, kind):
            a = node['attrs']
            if kind == 'Trade' and a.get('levelOfDetail') != 'EXECUTION':
                continue
            identifier = a.get('transactionID') or a.get('tradeID')
            if not identifier:
                warnings.append(kind + '缺少官方流水编号，未收录')
                continue
            if not re.fullmatch(r'[A-Za-z0-9._:-]{1,120}', identifier):
                invalid('官方流水编号无效')
            key = kind + ':' + identifier
            if key in event_ids:
                invalid('账单包含重复流水')
            event_ids.add(key)
            events.append({'id': key, 'kind': kind, 'data': a})
    if not cash:
        warnings.append('报表未提供分币种期末现金')
    warnings.append('持仓为期末快照；历史流水单独保留，不再次累加持仓或扣减现金')
    return {'provider': 'ibkr', 'externalAccount': external_account, 'fromDate': begin, 'toDate': end,
            'positions': positions, 'cash': cash, 'events': events, 'warnings': list(dict.fromkeys(warnings)),
            'sourceSha256': hashlib.sha256(raw).hexdigest(), 'sourceBytes': len(raw),
            'numericRepresentation': 'exact_source_decimal_text', 'financialEffect': 'none'}
