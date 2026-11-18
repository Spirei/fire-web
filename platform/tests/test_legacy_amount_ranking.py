import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import pytest

from alcor_api import legacy_amount_ranking as ranking
from alcor_api.market_discovery_protocol import CURRENCIES, stock_symbol


@pytest.mark.parametrize('market,exchange,prefix', [
    ('US', 'NASDAQ', 'WIRE'), ('HK', 'HKEX', '0200'), ('CN', 'SSE', '60010'),
])
async def test_app_amount_ranking_uses_observed_amounts_and_shared_cache(
    app, client, monkeypatch, market, exchange, prefix,
):
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
            return json.dumps({'totalCount': len(rows), 'data': rows}).encode()
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
    assert calls.count(ranking.TENCENT) == 10
    assert calls.count(ranking.SINA_LIST) == (2 if market == 'CN' else 0)
    assert calls.count(ranking.SINA_QUOTES) == (1 if market == 'CN' else 0)

    if market == 'US':
        assert (await client.get('/api/v2/market-ranking?market=US')).status_code == 503
        assert (await client.get(f'/api/v2/{path}', headers={'x-alcor-market-source': 'explicit'})).status_code == 400
