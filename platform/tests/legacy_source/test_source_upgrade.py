import json
import shutil
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg.errors import CheckViolation

from alcor_api.cli import create_user
from alcor_api.config import ROOT,Settings
from alcor_api.migrate import migrate
from alcor_api.fee_source_inventory import fingerprint,inventory
from alcor_api.source_mapping import Mapping
from alcor_api.source_snapshot import PgSnapshot,canonical,sha
from .synthetic_legacy import OWNER


@pytest.mark.asyncio
async def test_real_upgrade_keeps_unbound_original_bytes_rows_and_history_but_denies_new_authority(pg,old_pg,tmp_path):
    name='alcor_test_pre_authority_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    older_dir=tmp_path/'through-0031';older_dir.mkdir()
    for path in (ROOT/'migrations').glob('[0-9]*.sql'):
        if int(path.name[:4])<=31:shutil.copyfile(path,older_dir/path.name)
    settings=Settings(database_url=pg.get_uri(database=name),instance_id=uuid4(),environment='local',migration_dir=older_dir,connection_targets=[],redis_url=None,connection_secret_dir=tmp_path/'old-secrets',legacy_source_registry_path=None)
    try:
        await migrate(settings,name,initialize_empty=True)
        owner=await create_user(settings,'UnboundEvidenceOwner','Synthetic9Pass')
        bundle=Mapping(await PgSnapshot().export(old_pg,OWNER)).build();financial_bytes=canonical(bundle['financial']);fee=bundle['fee'];digest=fingerprint(fee);identifier=uuid4()
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=name),autocommit=True,row_factory=dict_row) as conn:
            await conn.execute('INSERT INTO financial_import_sources(owner_id,id,source_instance,source_owner,source_version,sha256,raw) VALUES(%s,%s,%s,%s,%s,%s,%s)',(owner,identifier,old_pg.instance,OWNER,'legacy-unbound-original-version',sha(financial_bytes),financial_bytes))
            await conn.execute('INSERT INTO fee_legacy_inventory_snapshots(owner_id,source_digest,source_instance,source_owner,complete,order_count,payload) VALUES(%s,%s,%s,%s,true,%s,%s)',(owner,digest,old_pg.instance,OWNER,len(fee['orders']),Jsonb(fee)))
            await conn.execute('INSERT INTO fee_legacy_inventory_heads VALUES(%s,%s,1)',(owner,digest))
            before_source=await(await conn.execute('SELECT * FROM financial_import_sources')).fetchone()
            before_fee=await(await conn.execute('SELECT * FROM fee_legacy_inventory_snapshots')).fetchone()
            before_migrations=await(await conn.execute('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).fetchall()
        upgraded=settings.model_copy(update={'migration_dir':ROOT/'migrations'})
        await migrate(upgraded,name)
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=name),autocommit=True,row_factory=dict_row) as conn:
            after_source=await(await conn.execute('SELECT * FROM financial_import_sources')).fetchone();after_fee=await(await conn.execute('SELECT * FROM fee_legacy_inventory_snapshots')).fetchone()
            assert after_source.pop('source_manifest_id') is None and after_fee.pop('source_manifest_id') is None
            assert after_source==before_source and after_fee==before_fee
            after_migrations=await(await conn.execute('SELECT name,sha256,applied_at FROM schema_migrations WHERE name=ANY(%s) ORDER BY name',([row['name'] for row in before_migrations],))).fetchall()
            assert after_migrations==before_migrations
            state=await inventory(conn,owner)
            assert not state['head']['complete'] and not state['head']['sourceVerified'] and state['head']['sourceDeclaredComplete'] is True
            assert (await(await conn.execute('SELECT count(*) n FROM legacy_source_grants')).fetchone())['n']==0
            with pytest.raises(CheckViolation,match='authorized original manifest bytes'):
                async with conn.transaction():
                    await conn.execute('INSERT INTO financial_import_sources(owner_id,id,source_instance,source_owner,source_version,sha256,raw) VALUES(%s,%s,%s,%s,%s,%s,%s)',(owner,uuid4(),old_pg.instance,OWNER,'new-unbound-not-authorized',sha(financial_bytes),financial_bytes))
            with pytest.raises(CheckViolation,match='active shared source manifest'):
                async with conn.transaction():
                    await conn.execute("INSERT INTO trade_fee_corrections(id,owner_id,trade_id,request_id,old_fees,new_fees,detail) VALUES(%s,%s,%s,%s,0,1,'{}')",(uuid4(),owner,uuid4(),uuid4()))
            assert (await(await conn.execute('SELECT count(*) n FROM financial_import_sources')).fetchone())['n']==1
    finally:
        with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
