from source_window_fixture import active_window
import json
from dataclasses import replace
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest
import pytest_asyncio
from pathlib import Path
from psycopg.rows import dict_row
from alcor_api.source_snapshot import PgSnapshot,SourceDefinition,schema_digest,canonical
from alcor_api.source_mapping import Mapping
from alcor_api.financial_families import family_coverage
from .segment_helpers import imported
from .synthetic_legacy import OWNER


@pytest_asyncio.fixture
async def old_pg(old_pg,pg):
    assert old_pg.expected_database.startswith('alcor_synthetic_legacy_')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),row_factory=dict_row) as conn:
        assert Path((await(await conn.execute('SHOW data_directory')).fetchone())['data_directory']).resolve()==old_pg.expected_data_directory.resolve()
        await conn.execute("CREATE TABLE card_amounts(user_id text,card_key text,amount numeric,currency text)")
        await conn.execute("CREATE TABLE card_details(user_id text,card_key text,card_number text,cvv text)")
        await conn.execute("CREATE TABLE user_settings(user_id text,fire text,simple text)")
        await conn.execute("INSERT INTO card_details VALUES(%s,'synthetic-card','PRIVATE-CARD-CONTENT','PRIVATE-CVV-CONTENT')",(OWNER,))
        await conn.execute("INSERT INTO card_amounts VALUES(%s,'synthetic-card',987.65,'USD')",(OWNER,))
        await conn.execute("INSERT INTO user_settings VALUES(%s,'PRIVATE-FIRE-CONTENT','PRIVATE-SIMPLE-CONTENT')",(OWNER,))
        await conn.execute("INSERT INTO account_financing_policy VALUES(%s,%s)",(OWNER,json.dumps({'currency':'USD','limit':100,'initialMargin':None,'maintenanceMargin':None})))
        schema=await PgSnapshot().schema(conn)
    yield replace(old_pg,expected_schema_hash=schema_digest(schema))


@pytest.mark.asyncio
async def test_unexported_actual_legacy_families_keep_owner_unknown_while_proven_account_stays_readable(client,admin,old_pg,app,pg):
    # The real source reader has no SELECT on these families; information_schema
    # omits them. pg_catalog structure still finds them without reading content.
    async with await psycopg.AsyncConnection.connect(old_pg.locator) as conn:
        assert not await(await conn.execute("SELECT 1 FROM information_schema.columns WHERE table_name='card_details'")).fetchone()
    grant,snapshot,account,record,finance=await imported(client,admin,old_pg)
    assert snapshot['coverage']['complete'] and snapshot['financialReady']
    assert not snapshot['coverage']['wholeLegacyFinancialComplete']
    families=snapshot['coverage']['financialFamilies']
    assert not families['wholeLegacyFinancialComplete'] and families['schemaEvidenceKnown']
    listed={item['family']:item for item in families['unresolvedFamilies']}
    assert set(listed)=={'cards','simple_ledger','financing'}
    card=next(item for item in listed['cards']['locations'] if item['table']=='card_details')
    assert card['observed'] is True and {'name':'cvv','type':'text'} in card['columns'] and not card['dataRowsRead']
    simple=listed['simple_ledger']['locations'][0]
    assert simple['observed'] and simple['requiredColumns']==['simple']
    current=await client.get('/api/legacy-financial/coverage')
    assert current.status_code==200,current.text
    state=current.json()
    assert state['brokerScopesComplete'] and not state['complete'] and not state['wholeLegacyFinancialComplete']
    assert {item['family'] for item in state['unresolvedFamilies']}==set(listed)
    raw=(await client.get('/api/legacy-financial/manifests/'+snapshot['manifestId']+'/raw')).content
    assert b'PRIVATE-' not in raw and b'987.65' not in raw
    assert json.loads(raw)['source']['financialFamilyEvidence']['dataRowsRead'] is True
    assert json.loads(raw)['tables']['account_financing_policy']['rows'][0]['user_id']['text']==OWNER
    assert all(ref['dataRowsRead'] for ref in listed['financing']['locations'])
    assert all(not ref['dataRowsRead'] for family in ('cards','simple_ledger') for ref in listed[family]['locations'])
    assert (await client.get('/api/portfolio/records')).status_code==409
    scoped=await client.get('/api/portfolio/records',params={'brokerAccountId':account})
    assert scoped.status_code==200 and scoped.json()['total']==1,scoped.text
    assert (await client.get('/api/trading/fills',params={'recordId':record})).status_code==200
    cash=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
    assert cash['complete'] and Decimal(cash['balance'])==Decimal('922.5') and not cash['ownerCashComplete']
    withdrawal={'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'external_withdrawal','amount':'1','occurredAt':'2026-03-01T10:00:00Z'}
    permitted=await client.post('/api/cash/preview',json=withdrawal)
    assert permitted.status_code==200,permitted.text
    assert Decimal(permitted.json()['balanceAfter'])==Decimal('921.5')
    assert permitted.json()['ownerCashAfter'] is None and not permitted.json()['ownerCashComplete']
    excessive={**withdrawal,'requestId':str(uuid4()),'amount':'1000'}
    assert (await client.post('/api/cash/preview',json=excessive)).status_code==409
    unchanged=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
    assert Decimal(unchanged['balance'])==Decimal('922.5') and not unchanged['ownerCashComplete']
    deposit={**withdrawal,'requestId':str(uuid4()),'action':'external_deposit','amount':'2'}
    proof=await client.post('/api/cash/preview',json=deposit)
    assert proof.status_code==200 and proof.json()['ownerCashAfter'] is None and not proof.json()['ownerCashComplete'],proof.text
    result=await client.post('/api/cash/operations',json={'data':deposit,'preview':proof.json()['preview']})
    assert result.status_code==200 and result.json()['ownerCashAfter'] is None and Decimal(result.json()['balanceAfter'])==Decimal('924.5'),result.text
    # Original completed financial UUID remains a receipt for the listed scope;
    # a new guard does not rewrite or revoke the already imported book.
    saved=await client.get('/api/financial-import/operations/'+finance['requestId'])
    assert saved.status_code==200 and saved.json()['financialApplied']


