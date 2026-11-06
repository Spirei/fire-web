"""Tencent original GBK protocol, normal licensed PG path and unknown-time boundary."""
import base64
import hashlib
import json
import re
import subprocess
from dataclasses import asdict,replace
from datetime import UTC,datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api.dividend_sources import Target
from alcor_api.market_authority import Policy
from alcor_api.market_contract import Query
from alcor_api.market_tencent_latest import observation,parse,symbol,VERSION
from alcor_api.market_transport import Transport
from alcor_api.market_worker import claim,execute,schedule
from market_latest_candidate.test_market_authority import market,market_settings,demand,read  # noqa:F401


def original(clock=None):
    fields=['']*68
    for index,value in {1:'真实合成证券',3:'340.000001',4:'330',5:'332',30:clock or datetime.now(UTC).isoformat(),31:'10.000001',32:'3.030303',33:'345',34:'329',36:'1234',37:'98765',38:'0.21',39:'27.4',43:'4.2',44:'12.34567891',47:'8.12',48:'380',49:'220',51:'4.5',52:'2.1',55:'1.1',62:'987654321',63:'876543210',65:'26.1',66:'1.23',67:'339.5'}.items():fields[index]=value
    return ('v_usAAPL="'+'~'.join(fields)+'";').encode('gbk')


def test_actual_old_fetch_batch_oracle_gbk_fields_and_units():
    source=Path(__file__).with_name('oracles').joinpath('tencentFetchBatch.ts').read_text()
    assert hashlib.sha256(source.encode()).hexdigest()=='9ad3b382b04522d66737b35fe0f5182f6f8a7691f02787ac0244ac919b0cb340'
    js=re.sub(r'^function parseLine\(.*?\{\s*symbol:.*?\| null \{','function parseLine(line) {',source,count=1)
    # Preserve the original function body; erase only its literal TypeScript types.
    js=js.replace(source.splitlines()[0],'function parseLine(line) {')if js.startswith('function parseLine(line:')else js
    js=re.sub(r'export async function fetchBatch\([^\n]+','async function fetchBatch(symbols,signal,publish) {',js)
    js=js.replace('new Map<string, Quote>()','new Map()').replace('let text: string;','let text;').replace('const quote: Quote =','const quote =')
    script='const DEFAULT_QUOTE_URL="https://qt.gtimg.cn/q="; const getSiteSettings=()=>({}); const raw=Buffer.from(process.argv[1],"base64"); const fetch=async()=>({ok:true,arrayBuffer:async()=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)});\n'+js+'\nfetchBatch(["usAAPL"]).then(map=>process.stdout.write(JSON.stringify(map.get("usAAPL"))));'
    raw=original('20261103150000');old=json.loads(subprocess.check_output(['node','-e',script,base64.b64encode(raw).decode()],text=True))
    actual=observation(raw,Query('latest','US','AAPL'))
    for key in ('price','change','changePct','volume','amount','pe','marketCap','epsTtm','totalShares','staticPe','averagePrice'):
        assert float(actual[key])==old[key]
    assert actual['name']==old['name']=='真实合成证券'
    assert actual['marketCap']=='1234567891.00000000'
    assert actual['volumeUnit']=='provider_native_shares_or_lots_not_normalized'
    assert symbol('US','BRK.B')=='usBRK.B'and symbol('US','AAPL.OQ')=='usAAPL'
    assert symbol('HK','700')=='hk00700'and symbol('CN','000858')=='sz000858'


def test_source_clock_unknown_never_uses_receipt_time_or_a_fake_zero():
    q=Query('latest','US','AAPL');raw=original('20261103150000')
    facts,issues,_=parse(raw,q,SimpleNamespace(timestamp_zones=()))
    assert facts==[]and issues[0]['reason']=='source_timestamp_unknown'
    facts,issues,_=parse(raw,q,SimpleNamespace(timestamp_zones=(('US','America/New_York'),)))
    assert facts[0]['at']=='2026-11-03T20:00:00+00:00'and issues==[]
    with pytest.raises(ValueError,match='mismatch'):observation(raw.replace(b'usAAPL',b'usMSFT'),q)


async def test_tencent_fixed_target_real_worker_original_owner_and_legacy_activation(market,monkeypatch):  # noqa:F811
    client,app,authority,_,_=market
    async with app.state.db.connection()as conn:owner=(await(await conn.execute('SELECT id FROM users')).fetchone())['id']
    target=Target('installed-tencent','tencent','qt.gtimg.cn',443,('8.8.8.8',),approved_access=True)
    policy=Policy('installed-tencent','tencent',VERSION,target.id,target.fingerprint,owner,'licensed-explicit-v1',('latest',),('US',),timestamp_zones=(('US','America/New_York'),))
    authority.policies=(policy,)
    response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id});assert response.status_code==200,response.text
    revision=response.json()['revision'];q=Query('latest','US','AAPL');raw=original();calls=[]
    async def fetch(url,approval):
        calls.append(url);assert url=='https://qt.gtimg.cn/q=usAAPL';assert approval['target']==['https','qt.gtimg.cn',443,'/q=usAAPL'];return raw
    monkeypatch.setattr('alcor_api.market_tencent_latest.fetch_page',fetch)
    await demand(client,revision,q);assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert await execute(authority,task,Transport(authority.db,[target]))=='observed'
    value=await read(client,revision,q);assert value.status_code==200,value.text
    assert value.json()['facts'][0]['price']=='340.000001'
    body={'items':[{'id':'aapl','market':'US','code':'AAPL'}]}
    quote=await client.post('/api/market/quotes/read',json=body,headers={'X-Alcor-Market-Source':revision})
    assert quote.status_code==200 and quote.json()['quoteStates']['aapl']['priceExact']=='340.000001',quote.text
    async with app.state.db.connection()as conn:
        page=await(await conn.execute('SELECT * FROM market_source_pages WHERE owner_id=%s',(owner,))).fetchone()
        assert bytes(page['raw_bytes'])==raw and page['raw_sha256']==hashlib.sha256(raw).hexdigest()
    installed=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'sources','patch':{'market_data_policies':[asdict(policy)],'dividend_source_targets':[asdict(target)]}})
    assert installed.status_code==200,installed.text
    selected=await client.put('/api/settings',json={'requestId':str(uuid4()),'privateRevision':1,'quoteSource':'tencent','quoteApiUrl':'https://qt.gtimg.cn/q=','currentPassword':'Synthetic9Pass'})
    assert selected.status_code==200,selected.text
    legacy=await client.post('/api/quotes',json=body)
    assert legacy.status_code==200 and legacy.json()['quotes']['aapl']['price']==340.000001,legacy.text
    # A current source licence change withdraws display, never erases raw or calls again.
    authority.policies=(replace(policy,license_revision='new-not-old-authority'),)
    denied=await read(client,revision,q);assert denied.status_code==503,denied.text
    assert len(calls)==1
