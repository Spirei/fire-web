"""F20 complete owner synchronization; no financial-source overwrite or external IO."""
import asyncio
import json
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from alcor_api.cli import create_user
from alcor_api.market_contract import canonical as exact_json
from fee_plan_source_candidate.test_fee_plan_sources import golden, vectors
from test_legacy_trade_corrections import native_headers
from test_trading import setup

__all__=['golden']
ROOT='/api/v2/app-state'


def field(*parts):
    return json.dumps(parts,ensure_ascii=False,separators=(',',':'))


def change(namespace,changes,request=None):
    return {'requestId':request or str(uuid4()),'namespace':namespace,'changes':changes}


async def test_minimum_owner_watermarks_do_not_grant_domain_data_and_cross_device_epoch(client,admin,db,app,settings):
    first=await native_headers(db,admin,scope='portfolio.read')
    second=await native_headers(db,admin,scope='portfolio.read')
    a=await client.get('/api/v2/account-sync',headers=first)
    b=await client.get('/api/v2/account-sync',headers=second)
    assert a.status_code==b.status_code==200,(a.text,b.text)
    assert a.json()['data']==b.json()['data']
    dto=a.json()['data'];assert set(dto)=={'version','userId','epoch','revisions'}
    assert dto['userId']==admin and str(UUID(dto['epoch']))==dto['epoch']
    canonical=await client.get('/api/client/account/changes',headers=first)
    assert canonical.status_code==200,canonical.text
    assert canonical.json()['domains']['resources']['state']=='forbidden'
    assert canonical.json()['revisions']['resources'] is None
    denied=await client.get('/api/client/resource-library/files',headers=first)
    assert denied.status_code==403,denied.text
    # Owner/principal context is not a portable per-device cursor.
    context=canonical.json()['context']
    wrong=await client.get('/api/client/account/changes',headers={**second,'x-alcor-context':context})
    assert wrong.status_code==403 and wrong.headers['x-alcor-retire-context']=='true'
    # Simulate a distinct restored identity only inside the verified isolated PG.
    async with db.connection() as conn:
        restored=uuid4()
        await conn.execute('UPDATE alcor_instance SET instance_id=%s WHERE singleton',(restored,))
        settings.instance_id=restored
    refreshed=await client.get('/api/v2/account-sync',headers=first)
    assert refreshed.status_code==200,refreshed.text
    assert refreshed.json()['data']['epoch']!=dto['epoch']
    old_context=await client.get('/api/client/account/changes',headers={**first,'x-alcor-context':context})
    assert old_context.status_code==403,old_context.text
    other=await create_user(settings,'SyntheticSyncOther','SyntheticSync9Pass')
    foreign=await native_headers(db,other,scope='portfolio.read')
    assert (await client.get('/api/v2/account-sync',headers=foreign)).json()['data']['userId']==other
    current_context=(await client.get('/api/client/account/changes',headers=first)).json()['context']
    foreign_context=await client.get('/api/client/account/changes',headers={**foreign,'x-alcor-context':current_context})
    assert foreign_context.status_code==403
    async with db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s',(admin,))
    revoked=await client.get('/api/v2/account-sync',headers=first)
    assert revoked.status_code==401 and revoked.headers['x-alcor-retire-context']=='true'


async def test_fee_source_sync_real_plans_history_tombstones_cas_and_cross_namespace_uuid(client,admin,db,golden,sync_decoder):
    fixture=await vectors(golden,client)
    headers=await native_headers(db,admin,scope='portfolio.read portfolio.write')
    original=fixture['plans'][0]
    import base64
    source=json.loads(base64.b64decode(original),parse_float=Decimal);pid=source['id'];key='plan/'+pid
    body=change('fees',[{'key':key,'revision':0,'value':original}])
    result=await client.post(ROOT,headers=headers,json=body)
    assert result.status_code==200,result.text
    receipt=result.json()['data'];assert receipt['state']=='completed'
    assert receipt['data']['fields'][key]=={'revision':1,'value':original}
    assert receipt['data']['fieldProvenance'][key]['authority']=='retained_legacy_original'
    assert (await client.post(ROOT,headers=headers,json=body)).json()==result.json()
    assert (await client.get(ROOT+'/operations/'+body['requestId'],headers=headers)).json()['data']==receipt
    crossed=await client.post(ROOT,headers=headers,json=change('watch',[{'key':field('notes','actual-record-id'),'revision':0,'value':'no UUID alias'}],body['requestId']))
    assert crossed.status_code==409,crossed.text
    invalid_same=await client.post(ROOT,headers=headers,json=change('fees',[{'key':key,'revision':0,'value':'notbase64'}],body['requestId']))
    assert invalid_same.status_code==409,invalid_same.text
    # Rewrite real revision2 from original bytes, preserving source date and identity.
    revised={**source,'revision':2,'overrides':{**source['overrides'],'commission':{**source['overrides']['commission'],'basis':'percent','rate':None}}}
    second=base64.b64encode(exact_json(revised).encode()).decode()
    missing_history=await client.post(ROOT,headers=headers,json=change('fees',[{'key':key,'revision':1,'value':second}]))
    assert missing_history.status_code==409,missing_history.text
    history='history/'+pid+'/1'
    update=change('fees',[{'key':history,'revision':0,'value':original},{'key':key,'revision':1,'value':second}])
    updated=await client.post(ROOT,headers=headers,json=update)
    assert updated.status_code==200 and updated.json()['data']['state']=='completed',updated.text
    current=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']['fields']
    assert current[key]=={'revision':2,'value':second} and current[history]['value']==original
    protected=await client.post(ROOT,headers=headers,json=change('fees',[{'key':history,'revision':1,'value':None}]))
    assert protected.status_code==409,protected.text
    # Competing devices retain one successful tombstone and one original conflict receipt.
    delete=change('fees',[{'key':'history/'+pid+'/2','revision':0,'value':second},{'key':key,'revision':2,'value':None}])
    other=change('fees',[{'key':key,'revision':2,'value':second}])
    results=await asyncio.gather(*(client.post(ROOT,headers=headers,json=data) for data in (delete,other)))
    assert all(row.status_code==200 for row in results),[row.text for row in results]
    assert sorted(row.json()['data']['state'] for row in results)==['completed','conflict']
    for data,response in zip((delete,other),results,strict=True):
        assert (await client.get(ROOT+'/operations/'+data['requestId'],headers=headers)).json()['data']==response.json()['data']
    tombstones=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']['fields']
    if tombstones[key]['value'] is not None:
        retired=await client.post(ROOT,headers=headers,json=change('fees',[
            {'key':'history/'+pid+'/2','revision':tombstones.get('history/'+pid+'/2',{'revision':0})['revision'],'value':second},
            {'key':key,'revision':tombstones[key]['revision'],'value':None}]))
        assert retired.status_code==200 and retired.json()['data']['state']=='completed',retired.text
    final=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']['fields']
    assert final[key]['value'] is None and final['history/'+pid+'/2']['value']==second
    older=json.loads(base64.b64decode(fixture['plans'][1]),parse_float=Decimal);older_key='history/'+older['id']+'/1'
    history_only=await client.post(ROOT,headers=headers,json=change('fees',[{'key':older_key,'revision':0,'value':fixture['plans'][1]}]))
    assert history_only.status_code==200 and history_only.json()['data']['state']=='completed',history_only.text
    history_fields=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']['fields']
    assert history_fields[older_key]['value']==fixture['plans'][1] and 'plan/'+older['id'] not in history_fields
    for encoded in (fixture['plans'][2],):
        item=json.loads(base64.b64decode(encoded),parse_float=Decimal)
        saved=await client.post(ROOT,headers=headers,json=change('fees',[{'key':'plan/'+item['id'],'revision':0,'value':encoded}]))
        assert saved.status_code==200 and saved.json()['data']['state']=='completed',saved.text
    for market,basis in (('connect',json.loads(base64.b64decode(fixture['plans'][2]),parse_float=Decimal)),('options',source)):
        item={**basis,'id':str(uuid4()),'revision':1,'market':market,
            'overrides':{name:rule for name,rule in basis['overrides'].items() if name in ('commission','platform')}}
        encoded=base64.b64encode(exact_json(item).encode()).decode()
        saved=await client.post(ROOT,headers=headers,json=change('fees',[{'key':'plan/'+item['id'],'revision':0,'value':encoded}]))
        assert saved.status_code==200 and saved.json()['data']['state']=='completed',saved.text
    import subprocess
    snapshot=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']
    checked=await asyncio.to_thread(subprocess.run,[str(sync_decoder),'--fees'],input=json.dumps(snapshot),capture_output=True,text=True,timeout=30,check=False)
    assert checked.returncode==0,checked.stderr
    assert checked.stdout.strip()=='five_fee_markets_decoded_exactly;no_financial_postings'
    async with db.connection() as conn:
        rows=await(await conn.execute('SELECT revision,legacy_original_base64 FROM fee_plan_revisions WHERE owner_id=%s AND id=%s ORDER BY revision',(admin,UUID(pid)))).fetchall()
        assert rows==[{'revision':1,'legacy_original_base64':original},{'revision':2,'legacy_original_base64':second}]
        for table in ('trade_ledger','cash_ledger_entries','portfolio_records'):
            assert not await(await conn.execute('SELECT 1 FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone()


async def test_real_note_only_commit_advances_owner_portfolio_signal_and_missing_hook_is_partial(client,admin,db):
    from f10_flat_candidate.test_flat_workflow import fill
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    entered=await client.post('/api/v2/orders',headers=headers,json=fill(record))
    assert entered.status_code==200,entered.text
    trade=entered.json()['data']['order']
    before=(await client.get('/api/v2/account-sync',headers=headers)).json()['data']
    note=await client.put('/api/v2/orders/'+trade['id'],headers=headers,json={'requestId':str(uuid4()),'note':'new display-only declaration','orderRevision':trade['revision'],'noteRevision':0})
    assert note.status_code==200 and note.json()['data']['financialHistoryChanged'] is False,note.text
    after=(await client.get('/api/v2/account-sync',headers=headers)).json()['data']
    assert after['revisions']['portfolio']==before['revisions']['portfolio']+1
    assert {k:v for k,v in after['revisions'].items() if k!='portfolio'}=={k:v for k,v in before['revisions'].items() if k!='portfolio'}
    async with db.connection() as conn:
        await conn.execute('ALTER TABLE legacy_flat_order_operations DISABLE TRIGGER account_signal_portfolio')
    incomplete=await client.get('/api/account/changes')
    assert incomplete.status_code==200,incomplete.text
    domain=incomplete.json()['domains']['portfolio']
    assert domain['state']=='partial' and 'legacy_flat_order_operations' in domain['missingSources']
    assert not domain['commitSignalComplete']
    legacy=await client.get('/api/v2/account-sync',headers=headers)
    assert legacy.status_code==503,legacy.text
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT tgenabled FROM pg_trigger WHERE tgrelid='legacy_flat_order_operations'::regclass AND tgname='account_signal_portfolio'")).fetchone())['tgenabled']=='D'


@pytest.mark.parametrize('headers',[[('authorization','')],[('authorization','Bearer ')],[('authorization','Bearer fat_invalid'),('authorization','Bearer fat_invalid')]])
async def test_supplied_credentials_duplicate_json_and_forbidden_financial_payload_cannot_mutate(client,admin,db,headers):
    rid=str(uuid4());body=change('watch',[{'key':field('notes','real-platform-record'),'revision':0,'value':'not financial'}],rid)
    for path in ('/api/v2/account-sync',ROOT+'?namespace=watch',ROOT+'/operations/'+rid,'/api/client/account/changes','/api/client/device-state'):
        refused=await client.get(path,headers=headers)
        assert refused.status_code==401,refused.text
    write=await client.post(ROOT,headers=headers,json=body)
    assert write.status_code==401,write.text
    full=await native_headers(db,admin,scope='portfolio.read portfolio.write')
    duplicate=json.dumps(body)[:-1]+',"namespace":"fees"}'
    malformed=await client.post(ROOT,headers={**full,'content-type':'application/json'},content=duplicate)
    assert malformed.status_code==400,malformed.text
    financial=await client.post(ROOT,headers=full,json=change('watch',[{'key':field('balance','record-id'),'revision':0,'value':'100000'}]))
    assert financial.status_code==400,financial.text
    async with db.connection() as conn:
        for table in ('watch_display_fields','watch_display_operations','fee_state_operations','fee_plan_revisions','trade_ledger','cash_ledger_entries','portfolio_records'):
            assert not await(await conn.execute('SELECT 1 FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone()


@pytest.fixture(scope='session')
def sync_decoder(golden):
    import hashlib
    import os
    import subprocess
    from pathlib import Path
    root=Path(os.environ['ALCOR_SYNC_IOS_ROOT'])
    evidence=json.loads((Path(__file__).parents[1]/'account_sync_watch_candidate/source-evidence.json').read_text())
    relative='StockLog/Models/AlcorAccountSync.swift'
    assert hashlib.sha256((root/relative).read_bytes()).hexdigest()==evidence['ios_sha256'][relative]
    binary=golden.parent/'sync-decoder'
    subprocess.run(['swiftc','-module-cache-path',str(golden.parent/'module-cache'),str(root/'StockLog/Models/AlcorPersonalFeePlan.swift'),str(root/relative),str(Path(__file__).with_name('Decode.swift')),'-o',str(binary)],capture_output=True,text=True,check=True,timeout=90)
    return binary


async def test_real_swift_decoder_accepts_http_snapshot_original_receipt_and_bound_cursor(client,admin,db,sync_decoder):
    import subprocess
    headers=await native_headers(db,admin,scope='portfolio.read portfolio.write')
    before=await client.get('/api/v2/account-sync',headers=headers)
    assert before.status_code==200,before.text
    command=change('watch',[{'key':field('notes','synthetic-record-id'),'revision':0,'value':'explicit display note'}])
    submitted=await client.post(ROOT,headers=headers,json=command)
    assert submitted.status_code==200,submitted.text
    snapshot=await client.get(ROOT+'?namespace=watch',headers=headers)
    after=await client.get('/api/v2/account-sync',headers=headers)
    original=await client.get(ROOT+'/operations/'+command['requestId'],headers=headers)
    assert snapshot.status_code==after.status_code==original.status_code==200
    assert original.json()==submitted.json()
    result=await asyncio.to_thread(subprocess.run,[str(sync_decoder)],input=json.dumps({'owner':admin,'before':before.json()['data'],'after':after.json()['data'],'snapshot':snapshot.json()['data'],'mutation':command,'receipt':original.json()['data']}),capture_output=True,text=True,timeout=30,check=False)
    assert result.returncode==0,result.stderr
    assert result.stdout.strip()=='decoded_actual_http;watch_change_only;receipt_valid;cross_device_cursor_rejected'


async def test_replaced_capture_body_is_partial_without_repair_or_fake_watermarks(client,admin,db):
    import hashlib
    import re
    from pathlib import Path

    from alcor_api.account_signals import CAPTURE_FUNCTION_SHA256
    # Assert against the actual last shipped definition, not an unrelated hash.
    definitions=[]
    for path in sorted((Path(__file__).parents[2]/'migrations').glob('*.sql')):
        for match in re.finditer(r'CREATE(?: OR REPLACE)? FUNCTION capture_account_change\(\).*?AS \$\$(.*?)\$\$;',path.read_text(),re.DOTALL):
            definitions.append((path,match.group(1)))
    assert definitions and hashlib.sha256(definitions[-1][1].encode()).hexdigest()==CAPTURE_FUNCTION_SHA256
    headers=await native_headers(db,admin,scope='portfolio.read')
    initial=await client.get('/api/v2/account-sync',headers=headers)
    assert initial.status_code==200,initial.text
    async with db.connection() as conn:
        await conn.execute("CREATE OR REPLACE FUNCTION capture_account_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$")
    changed=await client.get('/api/account/changes')
    assert changed.status_code==200,changed.text
    for domain in changed.json()['domains'].values():
        assert domain['state']=='partial' and domain['revision'] is None and not domain['commitSignalComplete']
        assert domain['missingSources']
    legacy=await client.get('/api/v2/account-sync',headers=headers)
    assert legacy.status_code==503,legacy.text
    async with db.connection() as conn:
        body=(await(await conn.execute("SELECT prosrc FROM pg_proc WHERE oid='public.capture_account_change()'::regprocedure")).fetchone())['prosrc']
        assert body==' BEGIN RETURN NULL; END '


async def test_real_old_config_discovery_reaches_swift_and_missing_contract_stays_disabled(client,sync_decoder):
    import subprocess
    for version in (1,2):
        response=await client.get(f'/api/v{version}/auth/config')
        assert response.status_code==200,response.text
        value=response.json()['data']
        assert value['account_sync']=={'version':1,'path':'/api/v2/account-sync','state_path':'/api/v2/app-state','operation_path':'/api/v2/app-state/operations/{requestId}',
            'namespaces':['watch','fees'],'domains':['profile','portfolio','watch','brokers','alerts','resources','feed','settings','authorization'],
            'interval_seconds':15,'patch_only':True,'automatic_mutation_replay':False}
        for payload,wanted in ((value,'protocol_supported_not_connection_confirmed'),
                ({key:item for key,item in value.items() if key!='account_sync'},'discovery_unavailable_sync_disabled'),
                ({'account_sync':{**value['account_sync'],'path':'https://not-the-same-origin.invalid'}},'discovery_unavailable_sync_disabled')):
            decoded=await asyncio.to_thread(subprocess.run,[str(sync_decoder),'--discovery'],input=json.dumps(payload),capture_output=True,text=True,timeout=30,check=False)
            assert decoded.returncode==0,decoded.stderr
            assert decoded.stdout.strip()==wanted


async def test_platform_projection_sync_reset_never_manufactures_original_and_unknown_market_is_not_empty(client,admin,db):
    from alcor_api.fee_plan_sources import original
    from fee_plan_source_candidate.test_fee_plan_sources import account, submit
    account_id=await account(client,'Synthetic platform-authored fee','longbridge','USD',['USD'])
    plan_id=str(uuid4())
    command={'requestId':str(uuid4()),'planId':plan_id,'revision':0,'accountId':account_id,'providerId':'longbridge','market':'us',
        'effectiveFrom':'2026-01-01','effectiveThrough':None,'components':{
            'commission':{'basis':'percent','rate':None},
            'platform':{'basis':'share','rate':'0.000000001234567890123456789','tiers':[],'graduated':True}},'confirmed':True}
    await submit(client,command)
    headers=await native_headers(db,admin,scope='portfolio.read portfolio.write')
    response=await client.get(ROOT+'?namespace=fees',headers=headers)
    assert response.status_code==200,response.text
    value=response.json()['data'];key='plan/'+plan_id;raw=value['fields'][key]['value']
    assert value['fieldProvenance'][key]['authority']=='platform_revision_projection_not_original'
    assert value['fieldProvenance'][key]['originalBytesRetained'] is False
    decoded=original(raw)
    assert decoded['overrides']['commission']['rate'] is None
    assert decoded['overrides']['platform']['rate']==Decimal('0.000000001234567890123456789')
    echo=change('fees',[{'key':key,'revision':value['fields'][key]['revision'],'value':raw}])
    saved=await client.post(ROOT,headers=headers,json=echo)
    assert saved.status_code==200 and saved.json()['data']['state']=='completed',saved.text
    assert (await client.get(ROOT+'/operations/'+echo['requestId'],headers=headers)).json()==saved.json()
    reset=change('fees',[{'key':'history/'+plan_id+'/1','revision':0,'value':raw},{'key':key,'revision':saved.json()['data']['data']['fields'][key]['revision'],'value':None}])
    retired=await client.post(ROOT,headers=headers,json=reset)
    assert retired.status_code==200 and retired.json()['data']['state']=='completed',retired.text
    read=(await client.get(ROOT+'?namespace=fees',headers=headers)).json()['data']
    assert read['fields'][key]['value'] is None and read['fields']['history/'+plan_id+'/1']['value']==raw
    assert read['fieldProvenance']['history/'+plan_id+'/1']['authority']=='platform_revision_projection_not_original'
    async with db.connection() as conn:
        stored=await(await conn.execute('SELECT legacy_original_base64 FROM fee_plan_revisions WHERE owner_id=%s AND id=%s',(admin,UUID(plan_id)))).fetchone()
        assert stored['legacy_original_base64'] is None
        assert (await(await conn.execute('SELECT retired_at FROM fee_plan_heads WHERE owner_id=%s AND id=%s',(admin,UUID(plan_id)))).fetchone())['retired_at'] is not None
    other=await account(client,'Synthetic old market unknown','longbridge','USD',['USD'])
    old={'requestId':str(uuid4()),'planId':str(uuid4()),'revision':0,'accountId':other,'providerId':'longbridge','effectiveFrom':'2026-01-01','effectiveThrough':'2026-12-31',
        'components':{'commission':{'basis':'percent','rate':'0.01'}},'confirmed':True}
    await submit(client,old)
    unknown=await client.get(ROOT+'?namespace=fees',headers=headers)
    assert unknown.status_code==409 and '市场未知' in unknown.json()['message'],unknown.text
    async with db.connection() as conn:
        for table in ('trade_ledger','cash_ledger_entries','portfolio_records'):
            assert not await(await conn.execute('SELECT 1 FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone()
