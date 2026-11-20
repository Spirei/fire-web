"""Live amount ranking for the original App routes."""

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
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
from .market_discovery_protocol import CURRENCIES, LIMIT, Target, document, iso, parse
from .market_public_dns import public_addresses
from .market_quote_proxy import TunnelBackend, quote_backend
from .market_tencent_latest import parse as parse_tencent
from .market_tencent_latest import symbol as tencent_symbol

SCANNER = 'scanner.tradingview.com'
TENCENT = 'qt.gtimg.cn'
SINA_LIST = 'vip.stock.finance.sina.com.cn'
SINA_QUOTES = 'hq.sinajs.cn'
RANKING_HOSTS = frozenset({SCANNER, TENCENT, SINA_LIST, SINA_QUOTES})
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


async def resolve_rank_source(host, address, path):
    async with httpcore.AsyncConnectionPool(
        network_backend=PinnedBackend(address, 443, address), max_connections=1,
    ) as pool:
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
    async with source_pool(SCANNER) as (pool, addresses):
        target = Target('legacy-amount-scanner', 'tradingview', SCANNER, addresses, True)
        _, url, body, _ = target.request(value)
        raw = await scanner_bytes(pool, addresses, url, body)
    return parse(raw, target, value, now)


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


async def collect(market):
    now = datetime.now(UTC)
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
                return {
                    'market': market, 'metric': 'amount', 'tradeDate': date, 'currency': CURRENCIES[market],
                    'updatedAt': iso(datetime.now(UTC)),
                    'items': [{**item, 'amount': float(item['amount'])} for item in items[:COUNT]],
                    'coverage': {'complete': True, 'observedCount': COUNT},
                }
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
                        result = await collect(market)
                except EXPECTED_SOURCE_FAILURES as error:
                    LOG.warning('market_amount_ranking_unavailable market=%s category=%s', market, type(error).__name__)
                    result = None
                self.cache[market] = (clock() + (180 if result else 15), result)
            if result is None:
                raise HTTPException(503, '热门股票暂时不可用')
            return result
