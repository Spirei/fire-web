"""Real licensed retained pages and real exact FX observations drive cap ordering."""
from datetime import UTC, datetime
from uuid import uuid4

import pytest_asyncio
from alcor_api.fx_reference import persist
from f25_asset_sources_candidate.test_sources import Provider, install, run, submit
from test_fx_reference import RAW


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):settings.file_root=tmp_path/'source-cap-images'


async def test_library_cap_order_uses_source_hash_and_exact_fx_and_revocation_removes_value(client,admin,app,db):
    targets=install(app,admin,('eastmoney','parqet'))
    provider=Provider()
    for market in ('US','HK'):
        queued=await submit(client,'sync',selection={'market':market})
        result=await run(client,app,provider,queued['requestId'])
        assert result['state']=='completed',result
    no_fx=await client.get('/api/attachments/library',params={'paged':'1','sort':'cap_desc'})
    assert no_fx.status_code==200 and no_fx.json()['sortApplied']=='code',no_fx.text
    assert no_fx.json()['unavailableReasons']==['verified_currency_conversion_unavailable']
    async with db.connection() as conn:
        await persist(conn,RAW,datetime.now(UTC),uuid4())
    ordered=await client.get('/api/attachments/library',params={'paged':'1','sort':'cap_desc'})
    assert ordered.status_code==200,ordered.text
    data=ordered.json()
    assert data['sortApplied']=='cap' and [row['code'] for row in data['items']]==['AUTO','00700']
    assert data['sortCurrency']=='USD' and data['conversionBasis']=='verified_exact_fx_observation'
    assert data['fxObservation']['observationDate']=='2026-01-02' and data['realTimePricesAssumed'] is False
    assert data['sourceAsOfKnown'] is False
    asc=(await client.get('/api/attachments/library',params={'paged':'1','sort':'cap_asc'})).json()
    assert [row['code'] for row in asc['items']]==['00700','AUTO']
    calls=len(provider.calls)
    targets[0]['approvedAccess']=False
    withdrawn=(await client.get('/api/attachments/library',params={'paged':'1','sort':'cap_desc'})).json()
    assert withdrawn['sortApplied']=='code' and all(row['marketCap'] is None for row in withdrawn['items'])
    assert all(row['metadataObservation']['state']=='retained_unavailable' for row in withdrawn['items'])
    assert len(provider.calls)==calls
