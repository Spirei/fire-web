from dataclasses import replace

import psycopg
import pytest
import pytest_asyncio
from alcor_api.source_snapshot import PgSnapshot, schema_digest
from legacy_source.helpers import authorized, export
from psycopg import sql
from psycopg.rows import dict_row


@pytest_asyncio.fixture
async def old_pg(old_pg,pg,request):
    mode=request.param
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
        if mode=='absent':await conn.execute('DROP TABLE account_financing_policy')
        elif mode=='unreadable':await conn.execute(sql.SQL('REVOKE SELECT ON account_financing_policy FROM {}').format(sql.Identifier(old_pg.expected_role)))
        else:await conn.execute('ALTER TABLE account_financing_policy ENABLE ROW LEVEL SECURITY')
    async with await psycopg.AsyncConnection.connect(old_pg.locator,row_factory=dict_row) as conn:schema=await PgSnapshot().schema(conn)
    yield replace(old_pg,expected_schema_hash=schema_digest(schema))


@pytest.mark.parametrize('old_pg',['absent','unreadable','rls'],indirect=True)
async def test_absent_policy_is_known_empty_but_no_select_or_rls_filter_is_unknown(client,admin,old_pg):
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    assert snapshot['financialReady']
    source=await client.get('/api/financing/policy/source',params={'accountKind':'real'})
    assert source.status_code==200,source.text
    if old_pg.expected_schema_hash:
        raw=await client.get('/api/legacy-financial/manifests/'+snapshot['manifestId']+'/raw')
        policy=raw.json()['tables']['account_financing_policy']
        metadata=raw.json()['source']
        if metadata['financialFamilyEvidence']['tables']['account_financing_policy']['observed'] is False:
            assert not policy['present'] and source.json()['state']=='available' and source.json()['policyKnown'] and source.json()['policy'] is None
        else:
            assert source.json()['state']=='blocked' and not source.json()['policyKnown'] and source.json()['policy'] is None
