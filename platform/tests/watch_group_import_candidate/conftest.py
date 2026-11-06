"""Only synthetic private source/platform PG; explicit operator schema registration."""

import json
from dataclasses import replace

import psycopg
import pytest_asyncio
from alcor_api.source_snapshot import PgSnapshot, schema_digest
from alcor_api.watch_group_source_snapshot import pg_schema
from alcor_api.watchlists import MARKETS
from legacy_source.conftest import admin, app, client
from legacy_source.conftest import old_pg as base_pg
from legacy_source.conftest import settings as base_settings
from legacy_source.synthetic_legacy import OWNER
from psycopg import sql
from psycopg.rows import dict_row

__all__=['admin', 'app', 'base_pg', 'base_settings', 'client']


@pytest_asyncio.fixture
async def old_pg(base_pg,pg):
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=base_pg.expected_database),autocommit=True,row_factory=dict_row) as conn:
        await conn.execute('CREATE TABLE watch_groups(id text PRIMARY KEY,user_id text,name text,icon text,sort bigint,visible bigint,kind text,market text,created_at text)')
        for position,(market,name) in enumerate(MARKETS):
            await conn.execute("INSERT INTO watch_groups VALUES(%s,%s,%s,'',%s,-1,'market',%s,'2026-01-01T00:00:00Z')",('old-market-'+market,OWNER,name,position,market))
        await conn.execute("INSERT INTO watch_groups VALUES('old-custom',%s,'Old research','',9,1,'custom','','2026-01-01T00:00:00Z')",(OWNER,))
        await conn.execute("INSERT INTO watch_groups VALUES('other-owner-group','unrelated-old-owner','OTHER-OWNER-SENTINEL','',0,1,'custom','','2026-01-01T00:00:00Z')")
        await conn.execute("UPDATE records SET watch_group_id='old-custom',watch_group_sort=7 WHERE id='old-record-1'")
        await conn.execute(sql.SQL('GRANT SELECT ON watch_groups TO {}').format(sql.Identifier(base_pg.expected_role)))
        digest=schema_digest(await PgSnapshot().schema(conn))
    return replace(base_pg,expected_schema_hash=digest)


@pytest_asyncio.fixture
async def settings(base_settings,old_pg,tmp_path):
    # base_settings uses this test's old_pg fixture and writes its same shared
    # registry v2/window; the supplemental file cannot choose another locator.
    async with await psycopg.AsyncConnection.connect(old_pg.locator,autocommit=True,row_factory=dict_row) as conn:
        digest=schema_digest(await pg_schema(conn))
    directory=tmp_path/'watch-registration';directory.mkdir(mode=0o700)
    path=directory/'watch.json';path.write_text(json.dumps({'version':1,'platformInstance':str(base_settings.instance_id),'watchGroups':[{'sourceAlias':old_pg.alias,'schemaHash':digest}]}));path.chmod(0o600)
    base_settings.watch_group_import_registry_path=path
    return base_settings
