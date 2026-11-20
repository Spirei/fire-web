"""Live amount ranking for the original App routes."""

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace
from urllib.parse import urlencode
from urllib.request import proxy_bypass_environment
from zoneinfo import ZoneInfo

import httpcore
from fastapi import HTTPException

from .fx_provider_transport import PinnedBackend, resolve
from .fx_reference import external_delivery_blocked
from .market_contract import Query, number
from .market_discovery_protocol import CURRENCIES, EXCHANGES, FILTERS, LIMIT, RANKING_MAX_AGE, Target, document, iso, numeric, parse
from .market_public_dns import public_addresses
from .market_quote_proxy import TunnelBackend, configured_tunnel, quote_backend
from .market_tencent_latest import parse as parse_tencent
from .market_tencent_latest import symbol as tencent_symbol

SCANNER = 'scanner.tradingview.com'
TENCENT = 'qt.gtimg.cn'
SINA_LIST = 'vip.stock.finance.sina.com.cn'
SINA_QUOTES = 'hq.sinajs.cn'
US_AMOUNT_FEED = 'push2.eastmoney.com'
US_AMOUNT_ROWS = 20
RANKING_HOSTS = frozenset({SCANNER, TENCENT, SINA_LIST, SINA_QUOTES, US_AMOUNT_FEED})
DNS_FALLBACKS = (('1.1.1.1', '/dns-query'), ('8.8.8.8', '/resolve'))
SINA_RANK_LIMIT = 30
ZONES = {'US': 'America/New_York', 'HK': 'Asia/Hong_Kong', 'CN': 'Asia/Shanghai'}
TENCENT_CLOCKS = SimpleNamespace(timestamp_zones=tuple(ZONES.items()))
NETWORK_FAILURES = (OSError, httpcore.NetworkError, httpcore.RemoteProtocolError, httpcore.TimeoutException)
EXPECTED_SOURCE_FAILURES = NETWORK_FAILURES + (ValueError, TypeError, KeyError, AttributeError, ArithmeticError,
                                               httpcore.LocalProtocolError, httpcore.ProxyError)
COUNT = 10
BATCH_SIZE = 12
MAX_CANDIDATES = 72
MAX_FUTURE = timedelta(minutes=3)
LOG = logging.getLogger(__name__)


@asynccontextmanager
async def source_pool(host, connections=1):
    addresses = await ranking_addresses(host)
    async with httpcore.AsyncConnectionPool(
        network_backend=PinnedBackend(host, 443, addresses), max_connections=connections,
    ) as pool:
        yield pool, addresses


async def response_bytes(pool, url, *, body=None, referer=None, limit=131072, accept=None):
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity'}
    if body is not None:
        headers.update({'Content-Type': 'application/json', 'Origin': 'https://www.tradingview.com'})
    if referer is not None:
        headers['Referer'] = referer
    if accept is not None:
        headers['Accept'] = accept
    method = 'GET' if body is None else 'POST'
    async with pool.stream(
        method, url, content=body, headers=headers,
        extensions={'timeout': {'connect': 4, 'read': 5, 'write': 4, 'pool': 5}},
    ) as response:
        if response.status != 200 or any(
            key.lower() == b'content-encoding' and value.lower() != b'identity'
            for key, value in response.headers
        ):
            raise ValueError('ranking_source_response_invalid')
        result = bytearray()
        async for chunk in response.aiter_stream():
            if len(result) + len(chunk) > limit:
                raise ValueError('ranking_source_response_too_large')
            result.extend(chunk)
        return bytes(result)


async def resolve_rank_source(host, address, path, *, proxied=False):
    backend = PinnedBackend(address, 443, address)
    if proxied:
        backend = await configured_tunnel(address, 443, (address,), resolver=resolve)
        if backend is None:
            raise ValueError('ranking_dns_proxy_unavailable')
    async with httpcore.AsyncConnectionPool(network_backend=backend, max_connections=1) as pool:
        params = urlencode({'name': host, 'type': 'A'})
        raw = await response_bytes(pool, f'https://{address}{path}?{params}',
                                   accept='application/dns-json', limit=8192)
    data = document(raw)
    if (not isinstance(data, dict) or data.get('Status') != 0 or data.get('TC') is not False
            or data.get('Question') not in ([{'name': host, 'type': 1}], [{'name': host + '.', 'type': 1}])):
        raise ValueError('ranking_public_dns_response_invalid')
    return public_addresses([row['data'] for row in data.get('Answer', []) if row['type'] == 1])


async def ranking_addresses(host):
    if host not in RANKING_HOSTS:
        raise ValueError('ranking_source_not_approved')
    try:
        async with asyncio.timeout(2):
            return public_addresses(await resolve(host, 443))
    except (OSError, ValueError):
        # A local resolver can return synthetic addresses. Try the fixed,
        # certificate-checked DNS endpoints within one fallback time budget.
        async with asyncio.timeout(3):
            tasks = [asyncio.create_task(resolve_rank_source(host, address, path))
                     for address, path in DNS_FALLBACKS]
            if os.environ.get('STOCKLOG_PROXY') and not proxy_bypass_environment(host):
                tasks.extend(asyncio.create_task(resolve_rank_source(host, address, path, proxied=True))
                             for address, path in DNS_FALLBACKS)
            try:
                last_error = None
                for lookup in asyncio.as_completed(tasks):
                    try:
                        return await lookup
                    except EXPECTED_SOURCE_FAILURES as error:
                        last_error = error
                raise last_error or ValueError('ranking_public_dns_unavailable')
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

async def scanner_universe(market, now):
    value = {'kind': 'ranking', 'metric': 'amount', 'market': market}
    local = now.astimezone(ZoneInfo(ZONES[market]))
    premarket = market == 'US' and local.time() < time(9, 30)
    async with source_pool(SCANNER) as (pool, addresses):
        target = Target('legacy-amount-scanner', 'tradingview', SCANNER, addresses, True)
        _, url, body, _ = target.request(value)
        if premarket:
            request = document(body)
            request['columns'].extend(('high[1]', 'volume[1]'))
            body = json.dumps(request, separators=(',', ':')).encode()
        raw = await scanner_bytes(pool, addresses, url, body)
    if premarket:
        today = datetime.combine(local.date(), time.min, UTC).timestamp()
        raw = previous_regular_universe(raw, today)
    return parse(raw, target, value, now)


def previous_regular_universe(raw, today):
    data = document(raw)
    rows = data.get('data')
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get('d'), list)
                                         or len(row['d']) != 10 for row in rows):
        raise ValueError('scanner_previous_bar_shape_invalid')
    days = [numeric(row['d'][4], positive=True) for row in rows]
    if today in days:
        previous = max((day for row, day in zip(rows, days, strict=True)
                        if day is not None and day < today and (numeric(row['d'][3]) or 0) > 0), default=None)
        if previous is None:
            raise ValueError('scanner_previous_session_unknown')
        for row, day in zip(rows, days, strict=True):
            if day != today:
                continue
            fields = row['d']
            high, volume = fields[-2:]
            if numeric(high, positive=True) is None or numeric(volume, positive=True) is None:
                raise ValueError('scanner_previous_bound_unknown')
            # An advanced symbol's previous daily bar supplies only its candidate
            # bound. Tencent still has to prove the amount and the trading date.
            fields[2:5] = high, volume, int(previous)
    for row in rows:
        del row['d'][8:]
    return json.dumps(data, default=str, separators=(',', ':')).encode()


async def scanner_bytes(pool, addresses, url, body):
    if not proxy_bypass_environment(SCANNER):
        try:
            backend = await quote_backend(url, addresses, resolver=resolve)
            if isinstance(backend, TunnelBackend):
                async with (asyncio.timeout(4),
                            httpcore.AsyncConnectionPool(network_backend=backend, max_connections=1) as proxy):
                    return await response_bytes(proxy, url, body=body, limit=LIMIT)
        except EXPECTED_SOURCE_FAILURES:
            pass
    return await retry_read(pool, url, body=body, limit=LIMIT)


async def retry_read(pool, url, **options):
    try:
        return await response_bytes(pool, url, **options)
    except NETWORK_FAILURES:
        return await response_bytes(pool, url, **options)


def ranking_item(market, code, name, amount, price, change, at, date, now):
    zone = ZoneInfo(ZONES[market])
    if not name.strip() or at.astimezone(zone).date().isoformat() != date or at > now + MAX_FUTURE:
        raise ValueError('ranking_quote_date_or_name_invalid')
    return {
        'market': market, 'code': code, 'name': name.strip(), 'amount': amount, 'price': float(price),
        'changePct': float(change), 'time': iso(at),
    }


async def tencent_quote(pool, market, candidate, date, now):
    code = candidate['code']
    try:
        # Symbols the quote source cannot represent remain in the exclusion proof.
        query = Query('latest', market, code).validate()
        symbol = tencent_symbol(market, code)
        raw = await retry_read(pool, f'https://{TENCENT}/q={symbol}')
        facts, _, _ = parse_tencent(raw, query, TENCENT_CLOCKS)
        fact, = facts
        amount = number(fact['amount'], positive=True) * (10000 if market == 'CN' else 1)
        if amount > Decimal(candidate['upper']):
            return None
        return ranking_item(
            market, code, fact['name'] or candidate['name'], amount, number(fact['price'], positive=True),
            number(fact['changePct'], signed=True), datetime.fromisoformat(fact['at']), date, now,
        )
    except EXPECTED_SOURCE_FAILURES:
        return None


def sina_list_url(sort, size):
    params = urlencode(dict(page=1, num=size, sort=sort, asc=int(sort == 'symbol'), node='hs_a', symbol=''))
    return f'https://{SINA_LIST}/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?{params}'


def sina_ranked_rows(raw):
    rows = document(raw.decode('gb18030'))
    if not isinstance(rows, list) or len(rows) != SINA_RANK_LIMIT:
        raise ValueError('sina_market_ranking_incomplete')
    ranked = []
    seen = set()
    for row in rows:
        symbol = row['symbol']
        amount = number(row['amount'], positive=True)
        if (not re.fullmatch(r'(?:sh|sz|bj)[0-9]{6}', symbol) or symbol in seen
                or ranked and amount > ranked[-1][1]):
            raise ValueError('sina_market_ranking_identity_or_order_invalid')
        seen.add(symbol)
        ranked.append((symbol, amount, row['ticktime']))
    return ranked


def beijing_rows(raw, selected, date, now):
    matched = dict(re.findall(r'var hq_str_([a-z0-9]+)="([^"]*)";', raw.decode('gb18030')))
    if matched.keys() != {symbol for symbol, _, _ in selected}:
        raise ValueError('sina_quote_identity_invalid')
    items = []
    zone = ZoneInfo(ZONES['CN'])
    for symbol, listed_amount, listed_time in selected:
        fields = matched[symbol].split(',')
        if len(fields) < 32 or date != fields[30]:
            raise ValueError('sina_ranking_clock_mismatch')
        at = datetime.fromisoformat(f'{date}T{fields[31]}').replace(tzinfo=zone)
        listed_at = datetime.fromisoformat(f'{date}T{listed_time}').replace(tzinfo=zone)
        lag = at - listed_at
        if not timedelta(0) <= lag <= timedelta(seconds=30) or at > now + MAX_FUTURE:
            raise ValueError('sina_ranking_clock_mismatch')
        amount = number(fields[9], positive=True)
        if amount < listed_amount - 1 or at == listed_at and amount > listed_amount + 1:
            raise ValueError('sina_ranking_amount_mismatch')
        if symbol.startswith('bj'):
            price = number(fields[3], positive=True)
            previous = number(fields[2], positive=True)
            items.append(ranking_item('CN', symbol[2:], fields[0], amount, price, (price / previous - 1) * 100,
                                      at, date, now))
    return items


async def beijing_ranking(date, now):
    # Sina's mainland amount ranking includes Beijing. Verify that the same
    # universe still contains Beijing, and tie the undated list to dated quotes.
    async with source_pool(SINA_LIST, connections=2) as (pool, _):
        by_amount, by_symbol = await asyncio.gather(
            response_bytes(pool, sina_list_url('amount', SINA_RANK_LIMIT)),
            response_bytes(pool, sina_list_url('symbol', 1)),
        )
    inventory = document(by_symbol.decode('gb18030'))
    if (not isinstance(inventory, list) or len(inventory) != 1
            or not re.fullmatch(r'bj[0-9]{6}', inventory[0]['symbol'])):
        raise ValueError('sina_beijing_scope_missing')
    ranked = sina_ranked_rows(by_amount)
    beijing = [row for row in ranked if row[0].startswith('bj')]
    # The leading mainland quote anchors the list's date when no Beijing stock ranks.
    selected = beijing or ranked[:1]
    symbols = ','.join(row[0] for row in selected)
    async with source_pool(SINA_QUOTES) as (pool, _):
        raw = await response_bytes(pool, f'https://{SINA_QUOTES}/list={symbols}',
                                   referer='https://finance.sina.com.cn/')
    return beijing_rows(raw, selected, date, now), ranked[-1][1] + 1


async def us_stock_codes():
    # The stock inventory does not depend on which daily bars have advanced.
    async with source_pool(SCANNER) as (pool, addresses):
        target = Target('legacy-amount-scanner', 'tradingview', SCANNER, addresses, True)
        _, url, body, _ = target.request({'kind': 'ranking', 'metric': 'amount', 'market': 'US'})
        query = document(body)
        query['columns'] = ['name', 'type', 'exchange', 'currency']
        raw = await scanner_bytes(pool, addresses, url, json.dumps(query, separators=(',', ':')).encode())
    data = document(raw)
    rows, total = data.get('data'), data.get('totalCount')
    if not isinstance(rows, list) or type(total) is not int or not COUNT <= total <= 20000 or len(rows) != total:
        raise ValueError('us_stock_inventory_incomplete')
    codes = set()
    for row in rows:
        fields = row['d']
        if not isinstance(fields, list) or len(fields) != 4:
            raise ValueError('us_stock_inventory_invalid')
        code, kind, exchange, currency = fields
        if (not isinstance(code, str) or not re.fullmatch(r'[A-Z0-9./\-]{1,24}', code)
                or kind != 'stock' or exchange not in EXCHANGES['US'] or currency != 'USD'
                or row['s'] != f'{exchange}:{code}' or code in codes):
            raise ValueError('us_stock_inventory_invalid')
        codes.add(code)
    return codes


async def us_amount_table():
    query = urlencode(dict(pn=1, pz=US_AMOUNT_ROWS, po=1, np=1, fltt=2, invt=2, fid='f6',
                           fs=FILTERS['US'], fields='f12,f14,f2,f3,f6,f124'))
    async with source_pool(US_AMOUNT_FEED) as (pool, _):
        raw = await retry_read(pool, f'https://{US_AMOUNT_FEED}/api/qt/clist/get?{query}')
    return document(raw)['data']


def verified_us_amount_items(table, stock_codes, now):
    rows, total = table.get('diff'), table.get('total')
    if not isinstance(rows, list) or len(rows) != US_AMOUNT_ROWS or type(total) is not int or total < len(rows):
        raise ValueError('us_amount_table_incomplete')
    zone = ZoneInfo(ZONES['US'])
    today = now.astimezone(zone).date().isoformat()
    items, seen, previous = [], set(), Decimal('Infinity')
    for row in rows:
        code = row['f12']
        amount = number(row['f6'], positive=True)
        if (not isinstance(code, str) or not re.fullmatch(r'[A-Z0-9./\-]{1,24}', code)
                or code in seen or amount > previous):
            raise ValueError('us_amount_table_identity_or_order_invalid')
        seen.add(code)
        previous = amount
        if code in stock_codes and len(items) < COUNT:
            stamp = numeric(row['f124'], positive=True)
            if stamp is None:
                raise ValueError('us_amount_table_timestamp_missing')
            at = datetime.fromtimestamp(stamp, UTC)
            if not time(9, 30) <= at.astimezone(zone).time() <= time(16, 0):
                raise ValueError('us_amount_table_session_invalid')
            items.append(ranking_item('US', code, row['f14'], amount, number(row['f2'], positive=True),
                                      number(row['f3'], signed=True), at, today, now))
    if len(items) != COUNT:
        raise ValueError('us_amount_table_stock_coverage_incomplete')
    return ranking_result('US', today, items)


async def us_regular_amount_ranking(now):
    async with asyncio.timeout(8):
        codes, table = await asyncio.gather(us_stock_codes(), us_amount_table(), return_exceptions=True)
    if isinstance(codes, BaseException):
        raise codes
    if isinstance(table, BaseException):
        raise table
    return verified_us_amount_items(table, codes, now)


def ranking_result(market, date, items):
    return {
        'market': market, 'metric': 'amount', 'tradeDate': date, 'currency': CURRENCIES[market],
        'updatedAt': iso(datetime.now(UTC)),
        'items': [{**item, 'amount': float(item['amount'])} for item in items[:COUNT]],
        'coverage': {'complete': True, 'observedCount': COUNT},
    }


async def collect(market):
    now = datetime.now(UTC)
    if market == 'US' and time(9, 30) <= now.astimezone(ZoneInfo(ZONES['US'])).time() < time(16, 0):
        try:
            return await us_regular_amount_ranking(now)
        except EXPECTED_SOURCE_FAILURES:
            # Retain the same verified original route when the turnover table fails.
            pass
    universe = await scanner_universe(market, now)
    date = universe['tradeDate']
    candidates = universe['candidates']
    items, remaining = [], Decimal(0)
    if market == 'CN':
        items, remaining = await beijing_ranking(date, now)
        candidates = [row for row in candidates if not tencent_symbol(market, row['code']).startswith('bj')]
    async with source_pool(TENCENT, connections=6) as (pool, _):
        for offset in range(0, min(len(candidates), MAX_CANDIDATES), BATCH_SIZE):
            batch = candidates[offset:offset + BATCH_SIZE]
            quotes = await asyncio.gather(*(tencent_quote(pool, market, row, date, now) for row in batch))
            for row, quote in zip(batch, quotes, strict=True):
                if quote is None:
                    remaining = max(remaining, Decimal(row['upper']))
                else:
                    items.append(quote)
            items.sort(key=lambda item: (-item['amount'], item['code']))
            rest = candidates[offset + len(batch):]
            unseen = Decimal(rest[0]['upper']) if rest else Decimal(0)
            if len(items) >= COUNT and items[COUNT - 1]['amount'] > max(remaining, unseen):
                return ranking_result(market, date, items)
    raise ValueError('ranking_top_ten_unverified')


class LegacyAmountRanking:
    def __init__(self, db):
        self.db = db
        self.locks = {market: asyncio.Lock() for market in ZONES}
        self.cache = {}

    async def read(self, market):
        async with self.locks[market]:
            clock = asyncio.get_running_loop().time
            until, result = self.cache.get(market, (0, None))
            if clock() >= until:
                async with self.db.connection() as conn:
                    if await external_delivery_blocked(conn):
                        raise HTTPException(503, '恢复隔离禁止行情采集')
                try:
                    async with asyncio.timeout(12):
                        fresh = await collect(market)
                except EXPECTED_SOURCE_FAILURES as error:
                    LOG.warning('market_amount_ranking_unavailable market=%s category=%s', market, type(error).__name__)
                    if (result is not None and datetime.fromisoformat(result['tradeDate']).replace(tzinfo=UTC)
                            < datetime.now(UTC) - RANKING_MAX_AGE):
                        result = None
                    self.cache[market] = (clock() + 15, result)
                else:
                    if result is None or fresh['tradeDate'] >= result['tradeDate']:
                        result = fresh
                    self.cache[market] = (clock() + 180, result)
            if result is None:
                raise HTTPException(503, '热门股票暂时不可用')
            return result
