"""Registered read-only watch tables only; no old services or financial row values."""

import asyncio
import stat
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from .source_snapshot import (
    PgSnapshot,
    SourceMismatch,
    canonical,
    pg_cell,
    schema_digest,
    sha,
)
from .source_window import require_source_access

TABLES={'watch_groups':('id','user_id','name','icon','sort','visible','kind','market','created_at'),'records':('id','user_id','watch_group_id','watch_group_sort','updated_at')}
MAX_BYTES=16*1024*1024
MAX_FIELD=65536
MAX_ROWS=50000


async def pg_schema(conn):
    rows=await (await conn.execute("SELECT table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY(%s) ORDER BY table_name,ordinal_position",(list(TABLES),))).fetchall()
    return {table:[{'name':r['column_name'],'type':r['data_type'],'nativeType':r['udt_name'],'nullable':r['is_nullable']=='YES'} for r in rows if r['table_name']==table and (table=='watch_groups' or r['column_name'] in TABLES[table])] for table in TABLES}




def validate_schema(schema,registration):
    if schema_digest(schema)!=registration.schema_hash:raise SourceMismatch('source_watch_schema_changed')
    if any({column['name'] for column in schema[table]}!=set(columns) for table,columns in TABLES.items()):raise SourceMismatch('source_watch_schema_incomplete_or_unsupported')


async def capture(definition,registration,owner,*,after_table=None):
    window=require_source_access(definition,owner)
    tables={name:[] for name in TABLES};used=0
    def append(table,row):
        nonlocal used
        size=len(canonical(row))
        if size>2*1024*1024 or used+size>MAX_BYTES or sum(map(len,tables.values()))>=MAX_ROWS:raise SourceMismatch('watch_source_requires_explicit_segmented_capture')
        tables[table].append(row);used+=size
    if definition.kind != "postgres":
        raise SourceMismatch("source_backend_not_supported")
    if definition.kind == "postgres":
        async with await psycopg.AsyncConnection.connect(definition.locator,autocommit=True,row_factory=dict_row,connect_timeout=5,options='-c statement_timeout=30000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=120000') as conn:
            await conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                identity=await (await conn.execute("SELECT current_database() database,current_user role,current_setting('data_directory') directory,current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,current_setting('server_encoding') encoding,pg_current_snapshot()::text snapshot,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,system_identifier::text FROM pg_control_system()")).fetchone()
                dataset={'kind':'postgres','systemIdentifier':identity['system_identifier'],'databaseOid':identity['database_oid']}
                if identity['database']!=definition.expected_database or identity['role']!=definition.expected_role or Path(identity['directory']).resolve()!=definition.expected_data_directory.resolve() or identity['ro']!='on' or identity['isolation']!='repeatable read' or identity['encoding']!='UTF8' or dataset!=definition.expected_dataset_identity:raise SourceMismatch('source_persistent_identity_not_verified')
                if schema_digest(await PgSnapshot().schema(conn))!=definition.expected_schema_hash:raise SourceMismatch('source_identity_schema_changed')
                if len(await (await conn.execute('SELECT id FROM users WHERE id=%s LIMIT 2',(owner,))).fetchall())!=1:raise SourceMismatch('source_owner_not_verified')
                schema=await pg_schema(conn);validate_schema(schema,registration)
                for table,columns in TABLES.items():
                    require_source_access(definition,owner)
                    expressions=[]
                    for index,column in enumerate(columns):
                        expressions.append(sql.SQL('CASE WHEN octet_length({}::text)>{} THEN NULL ELSE {}::text END AS {}').format(sql.Identifier(column),sql.Literal(MAX_FIELD),sql.Identifier(column),sql.Identifier('v'+str(index))))
                        expressions.append(sql.SQL('octet_length({}::text)>{} AS {}').format(sql.Identifier(column),sql.Literal(MAX_FIELD),sql.Identifier('large'+str(index))))
                    ordering=sql.SQL('watch_group_id,watch_group_sort,updated_at DESC,id::text COLLATE "C"') if table=='records' else sql.SQL('id::text COLLATE "C"')
                    query=sql.SQL('SELECT {} FROM {} WHERE user_id=%s ORDER BY {}').format(sql.SQL(',').join(expressions),sql.Identifier(table),ordering)
                    async with conn.cursor(name='watch_source_'+table) as cursor:
                        cursor.itersize=4;await cursor.execute(query,(owner,))
                        async for row in cursor:
                            require_source_access(definition,owner)
                            if any(row['large'+str(i)] for i in range(len(columns))):raise SourceMismatch('source_watch_field_too_large')
                            append(table,{column:pg_cell(row['v'+str(i)],next(c['type'] for c in schema[table] if c['name']==column),server_encoding=identity['encoding']) for i,column in enumerate(columns)})
                    if after_table:await after_table(table)
                require_source_access(definition,owner)
                return {'format':'legacy-watch-group-snapshot/1','source':{'instance':definition.instance,'owner':owner,'kind':definition.kind,'timezone':definition.timezone,'schemaHash':registration.schema_hash,'ownerVerified':True,'datasetIdentityVerified':True,'datasetIdentity':dataset,'readOnly':True,'isolation':'repeatable read','snapshotToken':identity['snapshot'],'migrationWindow':window.document()},'schema':schema,'tables':tables}
            finally:await conn.execute('ROLLBACK')
