import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import pytest

from alcor_api import legacy_amount_ranking as ranking
from alcor_api.market_discovery_protocol import CURRENCIES, stock_symbol


def test_us_premarket_recovers_previous_bar_bound():
    now = datetime(2026, 11, 20, 13, 0, tzinfo=UTC)
    today = int(datetime(2026, 11, 20, tzinfo=UTC).timestamp())
    previous = today - 86400
    advanced = {'s': 'NASDAQ:SNDK', 'd': ['SNDK', 'SNDK', 90, 10, today, 'stock', 'NASDAQ', 'USD', 105, 1000]}
    rest = [
        {'s': f'NASDAQ:WIRE{i}', 'd': [f'WIRE{i}', f'WIRE{i}', 80, 100, previous, 'stock', 'NASDAQ', 'USD', 85, 150]}
        for i in range(9)
    ]
    rows = {'totalCount': 10, 'data': [advanced, *rest]}
    result = ranking.previous_regular_universe(json.dumps(rows).encode(), today)
    target = ranking.Target('test', 'tradingview', ranking.SCANNER, ('1.0.0.1',), True)
    parsed = ranking.parse(result, target, {'kind': 'ranking', 'metric': 'amount', 'market': 'US'}, now)
    assert parsed['tradeDate'] == '2026-11-19'
    assert len(parsed['candidates']) == 10
    assert parsed['candidates'][0] == {
        'market': 'US', 'code': 'SNDK', 'name': 'SNDK', 'date': '2026-11-19', 'upper': '110250.00',
    }
    advanced['d'][-1] = None
    with pytest.raises(ValueError, match='scanner_previous_bound_unknown'):
        ranking.previous_regular_universe(json.dumps(rows).encode(), today)


@pytest.mark.parametrize('system,answer,expected', [
    (['1.0.0.1'], [], ('1.0.0.1',)),
    (['198.18.0.1'], [{'type': 1, 'data': '1.0.0.1'}], ('1.0.0.1',)),
    (['198.18.0.1'], [{'type': 1, 'data': '192.168.0.1'}], None),
])
async def test_ranking_dns_recovers_without_accepting_local_addresses(monkeypatch, system, answer, expected):
    calls = []

    async def resolve(host, port):
        assert (host, port) == (ranking.SCANNER, 443)
        return system

    async def fetch(pool, url, **options):
        calls.append(url)
        assert url in {f'https://{ip}{path}?name={ranking.SCANNER}&type=A'
                       for ip, path in ranking.DNS_FALLBACKS}
        assert options == dict(accept='application/dns-json', limit=8192)
        return json.dumps({'Status': 0, 'TC': False, 'Answer': answer,
                           'Question': [{'name': ranking.SCANNER if expected else ranking.SCANNER + '.', 'type': 1}]}).encode()

    monkeypatch.delenv('STOCKLOG_PROXY', raising=False)
    monkeypatch.setattr(ranking, 'resolve', resolve)
    monkeypatch.setattr(ranking, 'response_bytes', fetch)
    if expected is None:
        with pytest.raises(ValueError, match='address_not_approved'):
            await ranking.ranking_addresses(ranking.SCANNER)
    else:
        assert await ranking.ranking_addresses(ranking.SCANNER) == expected
    with pytest.raises(ValueError, match='ranking_source_not_approved'):
        await ranking.ranking_addresses('unexpected.example')
    assert bool(calls) == bool(answer)
    if expected is None:
        assert len(calls) == len(ranking.DNS_FALLBACKS)


async def test_ranking_dns_uses_a_valid_alternative_during_primary_timeout(monkeypatch):
    entered_primary = asyncio.Event()
    cancelled_primary = asyncio.Event()

    async def fake_system(_host, _port):
        return ['198.18.0.1']

    async def lookup(_pool, url, **_kwargs):
        if urlsplit(url).hostname == '1.1.1.1':
            entered_primary.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled_primary.set()
        assert urlsplit(url).hostname == '8.8.8.8'
        await entered_primary.wait()
        return json.dumps({'Status': 0, 'TC': False,
                           'Question': [{'name': ranking.SCANNER + '.', 'type': 1}],
                           'Answer': [{'type': 1, 'data': '1.0.0.1'}]}).encode()

    monkeypatch.delenv('STOCKLOG_PROXY', raising=False)
    monkeypatch.setattr(ranking, 'resolve', fake_system)
    monkeypatch.setattr(ranking, 'response_bytes', lookup)
    assert await ranking.ranking_addresses(ranking.SCANNER) == ('1.0.0.1',)
    assert cancelled_primary.is_set()


async def test_ranking_dns_can_recover_with_configured_proxy_when_direct_times_out(monkeypatch):
    cancelled_direct = 0

    async def system(_host, _port):
        return ['198.18.0.1']

    async def lookup(host, address, _path, *, proxied=False):
        nonlocal cancelled_direct
        assert host == ranking.SCANNER
        if not proxied:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled_direct += 1
        assert address in {address for address, _ in ranking.DNS_FALLBACKS}
        return ('1.0.0.1',)

    monkeypatch.setenv('STOCKLOG_PROXY', 'http://proxy.example:8080')
    monkeypatch.setattr(ranking, 'proxy_bypass_environment', lambda _host: False)
    monkeypatch.setattr(ranking, 'resolve', system)
    monkeypatch.setattr(ranking, 'resolve_rank_source', lookup)
    assert await ranking.ranking_addresses(ranking.SCANNER) == ('1.0.0.1',)
    assert cancelled_direct == len(ranking.DNS_FALLBACKS)


def test_us_regular_amount_uses_verified_inventory_and_observed_amount():
    now = datetime(2026, 11, 20, 15, 0, tzinfo=UTC)
    observed = datetime(2026, 11, 20, 14, 55, tzinfo=UTC)
    rows = [
        {'f12': f'WIRE{i}', 'f14': f'Security {i}', 'f2': 10, 'f3': -0.1,
         'f6': 8000 - i, 'f124': int(observed.timestamp())}
        for i in range(ranking.US_AMOUNT_ROWS)
    ]
    table = {'total': 100, 'diff': rows}
    membership = {f'WIRE{i}' for i in range(1, 12)}
    result = ranking.verified_us_amount_items(table, membership, now)
    assert result['tradeDate'] == '2026-11-20' and result['currency'] == 'USD'
    assert result['coverage'] == {'complete': True, 'observedCount': 10}
    assert [item['code'] for item in result['items']] == [f'WIRE{i}' for i in range(1, 11)]
    assert result['items'][0]['amount'] == 7999
    with pytest.raises(ValueError, match='us_amount_table_stock_coverage_incomplete'):
        ranking.verified_us_amount_items(table, {'WIRE1'}, now)
    rows[1]['f124'] = int((observed - timedelta(days=1)).timestamp())
    with pytest.raises(ValueError, match='ranking_quote_date_or_name_invalid'):
        ranking.verified_us_amount_items(table, membership, now)
    rows[-1]['f6'] = 9000
    with pytest.raises(ValueError, match='us_amount_table_identity_or_order_invalid'):
        ranking.verified_us_amount_items(table, set(), now)


@pytest.mark.parametrize('market,exchange,prefix', [
    ('US', 'NASDAQ', 'WIRE'), ('HK', 'HKEX', '0200'), ('CN', 'SSE', '60010'),
])
async def test_app_amount_ranking_uses_observed_amounts_and_shared_cache(
    app, client, monkeypatch, market, exchange, prefix,
):
    async def unavailable_regular_route(_now):
        raise ValueError('regular_source_unavailable')

    monkeypatch.setattr(ranking, 'us_regular_amount_ranking', unavailable_regular_route)
    zone = ZoneInfo(ranking.ZONES[market])
    date = datetime.now(zone).date() - timedelta(days=1)
    observed = datetime.combine(date, datetime.min.time(), zone).replace(hour=12)
    stamp = observed.strftime('%Y%m%d%H%M%S')
    day = int(datetime.combine(date, datetime.min.time(), UTC).timestamp())
    currency = CURRENCIES[market]
    codes = [prefix + str(i) for i in range(10)]
    rows = [
        {'s': f'{exchange}:{code}', 'd': [code, code, 20000, 10, day, 'stock', exchange, currency]}
        for code in codes
    ]
    if market == 'US':
        rows.append({'s': 'NYSE:LOW/PA', 'd': ['LOW/PA', 'Preferred', 10, 2, day, 'stock', 'NYSE', currency]})
    calls = []

    @asynccontextmanager
    async def pool(host, connections=1):
        yield host, ('1.1.1.1',)

    async def answer(host, url, **kwargs):
        calls.append(host)
        if host == ranking.SCANNER:
            includes_previous = 'high[1]' in json.loads(kwargs['body'])['columns']
            wire = [{**row, 'd': [*row['d'], None, None]} for row in rows] if includes_previous else rows
            return json.dumps({'totalCount': len(wire), 'data': wire}).encode()
        if host == ranking.SINA_LIST:
            if 'sort=symbol' in url:
                return b'[{"symbol":"bj920000"}]'
            rows_cn = [
                {'symbol': f'sh600{i:03d}', 'amount': 500 - i, 'ticktime': '12:00:00'}
                for i in range(ranking.SINA_RANK_LIMIT)
            ]
            return json.dumps(rows_cn).encode()
        if host == ranking.SINA_QUOTES:
            fields = [''] * 32
            fields[0], fields[9], fields[30], fields[31] = 'Mainland', '500.0', date.isoformat(), '12:00:00'
            return ('var hq_str_sh600000="' + ','.join(fields) + '";').encode()
        symbol = urlsplit(url).path.removeprefix('/q=')
        index = {stock_symbol(market, code): i for i, code in enumerate(codes)}[symbol]
        if market == 'US' and index == 0 and calls.count(ranking.TENCENT) == 1:
            raise TimeoutError
        fields = [''] * 38
        fields[1], fields[3], fields[30], fields[32], fields[36], fields[37] = (
            codes[index], '10', stamp, '0.25', '10', str(index + 1 if market == 'CN' else 100 + index),
        )
        return f'v_{symbol}="{"~".join(fields)}";'.encode()

    monkeypatch.setattr(ranking, 'source_pool', pool)
    monkeypatch.setattr(ranking, 'response_bytes', answer)
    app.state.legacy_amount_ranking = ranking.LegacyAmountRanking(app.state.db)
    path = f'market-ranking?market={market}&metric=amount'
    responses = await asyncio.gather(*(client.get(f'/api/v{version}/{path}') for version in (1, 2)))
    for response in responses:
        assert response.status_code == 200, response.text
        result = response.json()['data']
        assert (result['market'], result['currency'], result['tradeDate']) == (market, currency, date.isoformat())
        assert result['coverage'] == {'complete': True, 'observedCount': 10}
        assert [row['code'] for row in result['items']] == codes[::-1]
        assert result['items'][0]['amount'] == (100000 if market == 'CN' else 109)
    assert responses[0].json() == responses[1].json()
    assert calls.count(ranking.SCANNER) == 1
    assert calls.count(ranking.TENCENT) == (11 if market == 'US' else 10)
    assert calls.count(ranking.SINA_LIST) == (2 if market == 'CN' else 0)
    assert calls.count(ranking.SINA_QUOTES) == (1 if market == 'CN' else 0)

    if market == 'US':
        async def temporarily_unavailable(_market):
            raise TimeoutError

        service = app.state.legacy_amount_ranking
        _, verified = service.cache[market]
        service.cache[market] = (0, verified)
        monkeypatch.setattr(ranking, 'collect', temporarily_unavailable)
        retry = await client.get(f'/api/v2/{path}')
        assert retry.status_code == 200
        assert retry.json() == responses[1].json()

        assert (await client.get('/api/v2/market-ranking?market=US')).status_code == 503
        assert (await client.get(f'/api/v2/{path}', headers={'x-alcor-market-source': 'explicit'})).status_code == 400
