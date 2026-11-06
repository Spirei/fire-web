"""Deferred source-derived period and session vectors; no provider or PG calls."""

from datetime import datetime
from types import SimpleNamespace

from alcor_api.legacy_chart_series import minute_points
from alcor_api.legacy_history_bars import aggregate_observed_days


def test_original_period_aggregation_keeps_observed_dates_and_missing_volume():
    # Original lib/kline.ts aggregatePeriods labels a period by its final actual
    # daily observation, including a partial current period. Missing volume is
    # deliberately retained as unknown rather than the old fabricated sum zero.
    rows=[{'d':'2026-03-30','o':10,'h':14,'l':9,'c':13,'v':0},
          {'d':'2026-03-31','o':13,'h':15,'l':12,'c':14,'v':None},
          {'d':'2026-04-02','o':14,'h':16,'l':13,'c':15,'v':5}]
    assert aggregate_observed_days(rows,'week')==[
        {'d':'2026-04-02','o':10,'h':16,'l':9,'c':15,'v':None}]
    for frame in ('month','quarter'):
        assert aggregate_observed_days(rows,frame)==[
            {'d':'2026-03-31','o':10,'h':15,'l':9,'c':14,'v':None},rows[-1]]
    assert aggregate_observed_days(rows,'year')==[
        {'d':'2026-04-02','o':10,'h':16,'l':9,'c':15,'v':None}]


def test_full_session_and_session_day_select_different_observed_windows():
    policy=SimpleNamespace(source='controlled',source_version='source-v1')
    query=SimpleNamespace(market='US',session='ALL')
    def row(at,price,volume=None):
        return {'source_time':datetime.fromisoformat(at),'contents':{
            'at':at,'c':str(price),'v':volume,'source':policy.source,
            'sourceVersion':policy.source_version,'currency':'USD','session':'ALL'}}
    rows=[row('2026-10-20T19:59:00-04:00',10),
          row('2026-10-20T20:00:00-04:00',11,'0'),
          row('2026-10-21T04:00:00-04:00',12)]
    now=datetime.fromisoformat('2026-10-21T15:00:00+00:00')
    whole=minute_points(rows,policy,query,1,now)
    assert [(point['date'],point['time']) for point in whole]==[
        ('2026-10-20','20:00'),('2026-10-21','04:00')]
    assert whole[0]['volume']==0 and whole[1]['volume'] is None
    daytime=minute_points(rows,policy,query,1,now,session_day=True)
    assert [(point['date'],point['time']) for point in daytime]==[('2026-10-21','04:00')]
