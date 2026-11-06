import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from psycopg.errors import CheckViolation
from test_trade_amendments import P, command, complete
from test_trading import command as trade_command
from test_trading import submit as trade_submit

from .helpers import export
from .test_financial_mapping import imported


@pytest.mark.asyncio
async def test_authorized_imported_original_amendment_uses_current_source_and_keeps_completed_history_after_revoke(client,admin,old_pg,app):
    grant,source,account,record,_finance=await imported(client,admin,old_pg)
    db=app.state.db
    async with db.connection() as conn:
        raw=await(await conn.execute('SELECT * FROM trade_ledger ORDER BY id')).fetchall()
        originals=await(await conn.execute('SELECT raw,financial_raw FROM legacy_source_manifests')).fetchall()
        selected=next(row for row in raw if row['side']=='buy')
    head=await client.get(P,params={'recordId':record});assert head.status_code==200,head.text
    item=next(row for row in head.json()['items'] if row['tradeId']==str(selected['id']))
    assert item['canAmend'] and item['sourceAuthority']['sourceOrderId']=='old-order-1' and item['sourceAuthority']['lane']=='financial_import',item
    data=await command(client,record,str(selected['id']),price='20',fees='1')
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    newer,*_=await export(client,grant,predecessor=source['manifestSha256'])
    stale=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert stale.status_code==200 and stale.json()['state']=='failed',stale.text
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==stale.json()
    data=await command(client,record,str(selected['id']),price='20',fees='1')
    async with db.connection() as conn:originals=await(await conn.execute('SELECT raw,financial_raw FROM legacy_source_manifests')).fetchall()
    done,preview=await complete(client,data)
    assert Decimal(preview['cashEffect']['delta'])==-100 and Decimal(preview['cashEffect']['brokerAfter'])==Decimal('822.5')
    current=await client.get('/api/cash/accounts/'+account);assert current.status_code==200,current.text
    assert current.json()['currencies'][0]['complete'] and Decimal(current.json()['currencies'][0]['balance'])==Decimal('822.5'),current.text
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT * FROM trade_ledger ORDER BY id')).fetchall()==raw
        assert await(await conn.execute('SELECT raw,financial_raw FROM legacy_source_manifests')).fetchall()==originals
        evidence=(await(await conn.execute('SELECT evidence FROM trade_amendments WHERE id=%s',(done['amendmentId'],))).fetchone())['evidence']
        assert evidence['members'][0]['sourceAuthority']['manifestId']==newer['manifestId']
    # A known imported original and a new native actual fill may share the
    # same retained event; only the imported member carries source authority.
    current_record=(await client.get('/api/portfolio/records/'+record)).json()['record']
    native,_=await trade_submit(client,trade_command(current_record,quantity='10',price='20',amount='200',fees='0',occurredAt=datetime.now(UTC).isoformat()))
    merge=await command(client,record,str(selected['id']),price='20',fees='1')
    merge.update(action='merge',members=[{'tradeId':str(selected['id']),'expectedAmendmentId':done['amendmentId']},{'tradeId':native['tradeId'],'expectedAmendmentId':None}])
    merge['replacement']['quantity']='20'
    merged,_=await complete(client,merge)
    assert Decimal(merged['data']['cashEffect']['delta'])==0 and sum('sourceAuthority' in member for member in merged['data']['evidence']['members'])==1
    revoke=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert revoke.status_code==200,revoke.text
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==done
    read=await client.get('/api/portfolio/records/'+record);assert read.status_code==200 and Decimal(read.json()['record']['cost'])==Decimal('20.944'),read.text
    next_data=await command(client,record,str(selected['id']),price='21',fees='1')
    assert (await client.post(P+'/preview',json=next_data)).status_code==409
    async with db.connection() as conn:
        with pytest.raises(CheckViolation,match='current source grant'):
            async with conn.transaction():
                await conn.execute('INSERT INTO trade_amendments SELECT owner_id,%s,%s,record_id,trade_id,%s,previous_amendment_id,previous_record_amendment_id,before_record_revision,trade_tip_id,fee_projection_id,before_quantity,after_quantity,before_cost,after_cost,before_realized,after_realized,currency,cash_delta,before_event,replacement,evidence,evidence_raw,evidence_sha256,clock_timestamp(),action FROM trade_amendments WHERE id=%s',(uuid4(),uuid4(),uuid4(),done['amendmentId']))
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments')).fetchone())['n']==2


@pytest.mark.asyncio
async def test_pg_source_grant_revoke_and_correction_insert_serialize_without_http_authority_bypass(client,admin,old_pg,app):
    grant,_source,_account,record,_finance=await imported(client,admin,old_pg)
    async with app.state.db.connection() as conn:
        selected=(await(await conn.execute("SELECT id FROM trade_ledger WHERE owner_id=%s AND side='buy'",(admin,))).fetchone())['id']
    done,_=await complete(client,await command(client,record,str(selected),price='11',fees='1'))
    async def raw_insert():
        async with app.state.db.connection() as conn,conn.transaction():
            await conn.execute('INSERT INTO trade_amendments SELECT owner_id,%s,%s,record_id,trade_id,%s,previous_amendment_id,previous_record_amendment_id,before_record_revision,trade_tip_id,fee_projection_id,before_quantity,after_quantity,before_cost,after_cost,before_realized,after_realized,currency,cash_delta,before_event,replacement,evidence,evidence_raw,evidence_sha256,clock_timestamp(),action FROM trade_amendments WHERE id=%s',(uuid4(),uuid4(),uuid4(),done['amendmentId']))
    async with app.state.db.connection() as revoke:
        async with revoke.transaction():
            await revoke.execute("UPDATE legacy_source_grants SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=%s",(grant['grantId'],))
            pending=asyncio.create_task(raw_insert())
            try:
                blocked=False
                for _ in range(50):
                    await revoke.execute('SELECT pg_stat_clear_snapshot()')
                    blocked=bool(await(await revoke.execute("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query LIKE 'INSERT INTO trade_amendments SELECT%%' AND wait_event_type='Lock' LIMIT 1")).fetchone())
                    if blocked:break
                    await asyncio.sleep(.01)
                assert blocked and not pending.done(),'source correction must wait for the real PG permission row lock'
            except BaseException:
                pending.cancel();raise
        with pytest.raises(CheckViolation,match='current source grant'):
            await asyncio.wait_for(pending,5)
    assert (await client.get(P+'/operations/'+done['requestId'])).json()==done
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments')).fetchone())['n']==1
