"""A future minute cannot hide the most recent actually observed US quote."""
from dataclasses import asdict
from datetime import UTC, datetime
from types import SimpleNamespace
import json

import pytest
from alcor_api.market_contract import Query, futu_rows
from alcor_api.market_futu_sdk import collect
from alcor_api.market_worker import decode


OBSERVED = datetime(2026, 11, 12, 7, 26, 44, tzinfo=UTC)
QUERY = Query('latest', 'US', 'AAPL', session='OVERNIGHT')
SNAPSHOT = {'code':'US.AAPL','update_time':'2026-11-11 16:00:00',
            'last_price':355.63,'prev_close_price':348.51}
POINT = {'code':'US.AAPL','time':'2026-11-12 02:26:00','is_blank':False,
         'cur_price':355.9,'last_close':355.63}


def test_future_minute_is_excluded_using_the_retained_observation_clock():
    rows = [POINT, {**POINT,'time':'2026-11-12 02:27:00','cur_price':999}]
    raw = json.dumps({'records':[SNAPSHOT],'realTimeRecords':rows}).encode()
    policy = SimpleNamespace(source='futu',fixture=False)
    facts, issues, _ = decode(policy,QUERY,raw,observed_at=OBSERVED)
    assert not issues and len(facts)==1
    assert facts[0]['price']=='355.9' and facts[0]['change']=='0.27'
    assert facts[0]['at']=='2026-11-12T07:26:00+00:00'
    assert facts[0]['priceField']=='rt_data.cur_price' and facts[0]['individualSessionTradeTimeKnown'] is False
    # The same original and retained observation time replay identically.
    assert decode(policy,QUERY,raw,observed_at=OBSERVED)[0]==facts
    assert raw==json.dumps({'records':[SNAPSHOT],'realTimeRecords':rows}).encode()


@pytest.mark.parametrize('bad',[
    {**POINT,'code':'US.MSFT'}, {**POINT,'is_blank':True},
    {**POINT,'time':'2026-11-12 12:00:00'}, {**POINT,'last_close':None},
])
def test_an_invalid_newer_candidate_does_not_replace_a_valid_security_point(bad):
    facts,issues=futu_rows({'records':[SNAPSHOT],'realTimeRecords':[POINT,bad]},QUERY,observed_at=OBSERVED)
    assert not issues and len(facts)==1 and facts[0]['at']=='2026-11-12T07:26:00+00:00'


@pytest.mark.parametrize('rows,clock',[
    ([{**POINT,'time':'2026-11-12 02:27:00'}], OBSERVED),
    ([POINT,{**POINT,'cur_price':999}], OBSERVED),
    ([POINT,{**POINT,'time':'2026-11-12 02:25:00'}], None),
    ([POINT], OBSERVED.replace(tzinfo=None)),
])
def test_unobserved_or_ambiguous_quotes_stay_unknown(rows,clock):
    facts,issues=futu_rows({'records':[SNAPSHOT],'realTimeRecords':rows},QUERY,observed_at=clock)
    assert not facts and issues


def test_future_extended_snapshot_can_use_an_already_observed_real_minute():
    snapshot={**SNAPSHOT,'update_time':'2026-11-12 02:27:00','overnight_price':999,'overnight_change_val':1}
    facts,issues=futu_rows({'records':[snapshot],'realTimeRecords':[POINT]},QUERY,observed_at=OBSERVED)
    assert not issues and facts[0]['price']=='355.9' and facts[0]['at']=='2026-11-12T07:26:00+00:00'


def test_sdk_keeps_only_four_real_candidates_without_more_source_reads():
    rows=[{**POINT,'time':f'2026-11-12 02:{minute}:00'} for minute in range(22,28)]
    rows.append({**POINT,'is_blank':True})
    class Frame:
        def __init__(self,values):self.values=values
        def to_dict(self,orient):return self.values
    class Context:
        calls=[]
        closed=False
        def get_market_snapshot(self,symbols):self.calls.append(('snapshot',symbols));return 0,Frame([SNAPSHOT])
        def subscribe(self,symbols,types,**kwargs):self.calls.append(('subscribe',symbols));return 0,None
        def get_rt_data(self,symbol):self.calls.append(('minute',symbol));return 0,Frame(rows)
        def unsubscribe(self,symbols,types):self.calls.append(('unsubscribe',symbols))
        def close(self):self.closed=True
    context=Context()
    payload=collect(lambda **_:context,0,{'action':'latest','host':'controlled','port':11111,
        'symbols':['US.AAPL'],'query':asdict(QUERY)},
        {'Session':SimpleNamespace(ALL='all'),'SubType':SimpleNamespace(RT_DATA='minute')})
    assert payload['realTimeRecords']==rows[2:6] and context.closed
    assert context.calls==[('snapshot',['US.AAPL']),('subscribe',['US.AAPL']),('minute','US.AAPL'),('unsubscribe',['US.AAPL'])]


def test_after_hours_uses_observed_minute_when_snapshot_only_has_regular_clock():
    query = Query('latest', 'US', 'AAPL', session='AFTER')
    observed = datetime(2026, 11, 11, 21, 6, 20, tzinfo=UTC)
    snapshot = {**SNAPSHOT, 'update_time': '2026-11-11 15:59:00', 'after_price': 999}
    after = {**POINT, 'time': '2026-11-11 16:06:00'}
    rows = [after, {**after, 'time': '2026-11-11 16:07:00'}, POINT]
    facts, issues = futu_rows({'records': [snapshot], 'realTimeRecords': rows}, query, observed_at=observed)
    assert not issues and len(facts) == 1
    quote = facts[0]
    assert (quote['session'], quote['at']) == ('AFTER', '2026-11-11T21:06:00+00:00')
    assert (quote['price'], quote['prevClose'], quote['change']) == ('355.9', '355.63', '0.27')
    assert quote['priceField'] == 'rt_data.cur_price'
