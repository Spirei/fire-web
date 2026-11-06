"""Read the actual old serializer, preserving every old wallet-entry field/value."""
import asyncio
import json
import re
import subprocess

from test_card_wallet import KEY, apply, owner
from frozen_legacy import source_root


async def test_old_typescript_wallet_entry_serializer_matches_http(client):
    root=source_root('ALCOR_MARKET_LEGACY_ROOT', ['lib/cardWallet.ts'])
    source=(root/'lib/cardWallet.ts').read_text()
    function=re.search(r'function toBalanceEntry\(row: BalanceRow\): CardBalanceEntry \{.*?\n\}',source,re.DOTALL)
    assert function
    await owner(client)
    await apply(client,'set_amount','100')
    result,_=await apply(client,'withdraw','2.25',when='2020-01-02T00:00:00Z')
    response=await client.get('/api/cards/wallet',params={'cardKey':KEY})
    assert response.status_code==200,response.text
    actual=response.json()['entries'][0]
    row={'id':result['requestId'],'card_key':KEY,'kind':'withdraw','delta':-2.25,'balance':97.75,'note':'','occurred_at':actual['occurredAt'],'fund_tx_id':None}
    script="const ts=require('typescript');const src=process.argv[1];eval(ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText);process.stdout.write(JSON.stringify(toBalanceEntry(JSON.parse(process.argv[2]))));"
    old=json.loads(await asyncio.to_thread(subprocess.check_output,['node','-e',script,function.group(),json.dumps(row)],text=True))
    assert {key:actual[key] for key in old}==old
    assert set(actual)-set(old)=={'currency','cancelled','projectionRevision'}


async def test_old_put_wallet_returns_original_masked_details_snapshot_and_preserves_omitted_fields(client,db):
    from uuid import uuid4

    from test_card_wallet import ROOT
    uid=await owner(client)
    rid=str(uuid4())
    body={'cardKey':KEY,'number':'4111 1111 1111 1111','expiry':'12/2099','cvv':'9876','note':'Synthetic old note','currency':'USD'}
    saved=await client.put('/api/cards/wallet',json=body,headers={'x-alcor-request-id':rid})
    assert saved.status_code==200,saved.text
    old=saved.json()
    assert set(old)=={'details','secretFields'} and old['secretFields']=='masked'
    assert old['details'][KEY]['note']=='Synthetic old note' and old['details'][KEY]['numberLast4']=='1111'
    assert '4111 1111' not in saved.text and '12/2099' not in saved.text and '9876' not in saved.text
    changed=await client.put('/api/cards/wallet',json={'cardKey':KEY,'note':'New note'})
    assert changed.status_code==200 and changed.json()['details'][KEY]['note']=='New note',changed.text
    assert (await client.put('/api/cards/wallet',json=body,headers={'x-alcor-request-id':rid})).json()==old
    assert (await client.put('/api/cards/wallet',json={**body,'note':'Changed intent'},headers={'x-alcor-request-id':rid})).status_code==409
    revealed=await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True})
    assert revealed.status_code==200 and revealed.json()['cvv']=='9876' and revealed.json()['expiry']=='12/2099'
    bad=await client.put('/api/cards/wallet',json={'cardKey':KEY,'note':'x'*61})
    assert bad.status_code==400
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM card_wallet_operations WHERE owner_id=%s',(uid,))).fetchone())['n']==2
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(uid,))).fetchone())['n']==0


async def test_old_financial_note_string_trim_and_utf16_storage_match_actual_javascript(client):
    root=source_root('ALCOR_MARKET_LEGACY_ROOT', ['app/api/cards/amounts/route.ts'])
    source=(root/'app/api/cards/amounts/route.ts').read_text()
    assert 'const note = String((body as { note?: unknown }).note ?? "").trim().slice(0, 100);' in source
    await owner(client)
    values=[None,False,{'test':'not a financial value'},'\ufeff  Synthetic note  \t','😀'*49+'a😀']
    script="const x=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(x.map(v=>Buffer.from(String(v??'').trim().slice(0,100),'utf8').toString('utf8'))));"
    expected=json.loads(await asyncio.to_thread(subprocess.check_output,['node','-e',script,json.dumps(values)],text=True))
    for index,(value,note) in enumerate(zip(values,expected,strict=True)):
        saved=await client.put('/api/cards/amounts',json={'cardKey':f'synthetic/note{index}.png','amount':1,'currency':'USD','note':value})
        assert saved.status_code==200 and saved.json()['amount']['note']==note,saved.text
