"""PG quote publication and current source permission are one alert commit boundary."""
import hashlib
from uuid import uuid4

from alcor_api.market_alert_reader import project_alert_demands
from alcor_api.market_worker import claim,execute,schedule
from alcor_api.price_alert_worker import claim as claim_alert,execute as execute_alert
from alcor_api.business_notification_worker import dispatch_one
from alcor_api.notification_sender import Sender
from tests.market_latest_candidate.test_market_authority import market
from tests.market_latest_candidate.test_market_alerts import market_settings,attach
from tests.price_alerts_candidate.test_price_alerts import alert_settings,upsert
from tests.price_alerts_candidate.test_alert_delivery_concurrency import bind_wechat

__all__=['market','market_settings','alert_settings']


async def prepare(market):
    client,app,authority,transport,revision=market
    alerts,clock=await attach(app,authority)
    wire=await bind_wechat(client,app,alerts)
    _,receipt,rid=await upsert(client)
    assert await project_alert_demands(authority)==1
    assert await schedule(authority)==1
    task=await claim(app.state.db,uuid4())
    assert await execute(authority,task,transport)=='observed'
    async with app.state.db.connection() as conn:
        page=await(await conn.execute('SELECT * FROM market_source_pages')).fetchone()
    return client,app,authority,transport,revision,alerts,wire,receipt,rid,page


async def test_revoke_after_pg_quote_read_prevents_event_without_losing_raw_or_recalling_provider(market):
    client,app,authority,transport,revision,alerts,wire,_,_,page=await prepare(market)
    reader=alerts.reader
    original=reader.read
    async def revoked(rule):
        quote=await original(rule)
        assert quote is not None
        response=await client.request('DELETE','/api/market/sources/'+revision,json={'request_id':str(uuid4())})
        assert response.status_code==200,response.text
        return quote
    reader.read=revoked
    messages=len(wire.messages)
    task=await claim_alert(app.state.db,uuid4())
    assert await execute_alert(alerts,task)=='source_authorization_changed'
    assert (await client.get('/api/price-alerts')).json()['events']==[]
    assert await dispatch_one(app.state.db,uuid4(),Sender(alerts.bindings))=='idle'
    assert len(wire.messages)==messages and transport.calls==1
    async with app.state.db.connection() as conn:
        kept=await(await conn.execute('SELECT raw_bytes,raw_sha256 FROM market_source_pages WHERE id=%s',(page['id'],))).fetchone()
        assert bytes(kept['raw_bytes'])==bytes(page['raw_bytes'])
        assert kept['raw_sha256']==hashlib.sha256(bytes(page['raw_bytes'])).hexdigest()
        current=await(await conn.execute('SELECT status,result FROM tasks WHERE id=%s',(task['id'],))).fetchone()
        assert current['status']=='queued' and current['result']['monitoringState']=='source_authorization_changed'
        assert (await(await conn.execute("SELECT count(*) n FROM business_notification_events WHERE kind='price.alert'")).fetchone())['n']==0
        assert (await(await conn.execute("SELECT count(*) n FROM business_notification_deliveries d JOIN business_notification_events e ON e.owner_id=d.owner_id AND e.id=d.event_id WHERE e.kind='price.alert'")).fetchone())['n']==0


async def test_busy_market_lock_defers_same_job_then_one_pg_event_and_one_controlled_delivery(market):
    client,app,authority,transport,_,alerts,wire,receipt,rid,page=await prepare(market)
    async with app.state.db.connection() as held:
        async with held.transaction():
            await held.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('market-owner:'+page['owner_id'],))
            task=await claim_alert(app.state.db,uuid4())
            assert await execute_alert(alerts,task)=='market_authority_busy'
            assert (await client.get('/api/price-alerts')).json()['events']==[]
    async with app.state.db.connection() as conn:
        state=await(await conn.execute('SELECT status FROM tasks WHERE id=%s',(task['id'],))).fetchone()
        assert state['status']=='queued'
        await conn.execute("UPDATE price_alert_jobs SET next_scan_at=clock_timestamp()-interval '1 second' WHERE task_id=%s",(task['id'],))
    again=await claim_alert(app.state.db,uuid4())
    assert again['id']==task['id']
    assert await execute_alert(alerts,again)=='triggered'
    snapshot=(await client.get('/api/price-alerts')).json()
    assert len(snapshot['events'])==1 and snapshot['events'][0]['priceExact']=='340.000001'
    count=len(wire.messages)
    assert await dispatch_one(app.state.db,uuid4(),Sender(alerts.bindings))=='accepted'
    assert await dispatch_one(app.state.db,uuid4(),Sender(alerts.bindings))=='idle'
    assert len(wire.messages)==count+1 and transport.calls==1
    assert (await client.get('/api/price-alerts/operations/'+rid)).json()==receipt
