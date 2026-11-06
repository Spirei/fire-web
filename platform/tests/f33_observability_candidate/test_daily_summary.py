"""Observed security movement remains distinct from actual historical account profit."""
from uuid import uuid4

from alcor_api.market_contract import Query
from alcor_api.market_worker import claim, execute, schedule
from f16_history_candidate.test_history_protocols import seeded
from market_latest_candidate.test_market_authority import demand, market, market_settings  # noqa: F401
from test_trading import setup


async def test_daily_summary_exact_observations_no_fabricated_historical_profit(market):  # noqa: F811
    client,app,authority,revision,transport,_headers=await seeded(market)
    await demand(client,revision,Query('bars','US','AAPL','day','none',start='2026-10-20',through='2026-10-21'))
    assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.history')
    assert await execute(authority,task,transport)=='complete'
    _,record=await setup(client,qty='2',cost='5')
    before=transport.calls
    response=await client.get('/api/activities/daily-summary')
    assert response.status_code==200,response.text
    body=response.json();item=next(p for b in body['books'] for p in b['positions'] if p['recordId']==record['id'])
    assert str(item['currentExposurePriceMoveEstimate'])=='2'
    assert item['actualPnl'] is None
    assert item['previousDate']=='2026-10-20' and item['date']=='2026-10-21'
    assert body['lastTradingDayVerified'] is False
    assert body['calculation']['wholeAccountDailyProfitKnown'] is False
    assert body['calculation']['collectionOnRead'] is False
    assert transport.calls==before
    authority.policies=()
    damaged=await client.get('/api/activities/daily-summary')
    assert damaged.status_code==200,damaged.text
    position=next(p for b in damaged.json()['books'] for p in b['positions'] if p['recordId']==record['id'])
    assert position['actualPnl'] is None and position['currentExposurePriceMoveEstimate'] is None
    assert transport.calls==before
