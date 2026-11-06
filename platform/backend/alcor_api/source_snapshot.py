"""Allowlisted read-only, repeatable snapshots; never opens a source from HTTP input."""

import base64
import hashlib
import json
import struct
from dataclasses import dataclass,field
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from .financial_families import FAMILY_TABLES,structure_evidence,captured_family_evidence


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()


def sha(value):return hashlib.sha256(value).hexdigest()


# All source data is financial. In particular, broker_connections, users, tokens,
# fee_preview_key and worker leases are deliberately never queried.
TABLES={
 'account_financing_policy':('user_id value','user_id'),
 'account_financing_requests':('user_id request_id payload result','user_id'),
 'records':('id user_id name code market account_market price qty cost group_name watch_group_id watch_group_sort note source broker_account_id revision updated_at', 'user_id'),
 'record_revisions':('user_id record_id revision','user_id'),
 'broker_accounts':('id user_id name provider_id currency currencies_json account_kind holding_source revision created_at updated_at','user_id'),
 'trade_orders':('id user_id record_id market code name side status qty price fees amount realized_pnl position_qty_after position_cost_after broker note traded_at created_at position_qty_before position_cost_before order_no order_type trigger_price tif expires_at session trigger_status settlement_currency settlement_amount','user_id'),
 'app_asset_order_versions':('order_id revision','order'),
 'app_trade_metadata':('order_id parent_id role trigger_above draft_json identity_json','order'),
 'fund_transactions':('id user_id currency type amount direction note occurred_at created_at','user_id'),
 'broker_cash_accounts':('user_id account_id currency revision opening_amount opening_at opening_basis','user_id'),
 'broker_cash_entries':('id user_id account_id currency kind amount direction occurred_at created_at note operation_id fund_id','user_id'),
 'broker_cash_order_links':('order_id user_id account_id currency','user_id'),
 'trade_fee_details':('order_id user_id input_json detail_json created_at','user_id'),
 'trade_fee_evidence':('order_id user_id source input_hash detail_json created_at','user_id'),
 'trade_fee_corrections':('order_id user_id request_id source old_fees new_fees detail_json created_at','user_id'),
 'trade_fee_detail_history':('id order_id user_id input_json detail_json archived_at','user_id'),
 'trade_correction_originals':('order_id user_id request_id replacement_id original_json created_at','user_id'),
 'trade_correction_replacements':('order_id user_id request_id created_at','user_id'),
 'trade_correction_operations':('user_id request_id request_hash','user_id'),
 'app_asset_operations':('user_id request_id result_json','user_id'),
}
EXCLUDED_COLUMNS={'broker_accounts':{'icon':'nonfinancial_media_export_separate'}}


@dataclass(frozen=True)
class SourceDefinition:
    alias:str
    instance:str
    kind:str
    owners:tuple[str,...]
    timezone:str|None
    expected_schema_hash:str
    locator:str=field(repr=False)
    expected_database:str|None=None
    expected_data_directory:Path|None=field(default=None,repr=False)
    expected_role:str|None=None
    expected_file_identity:tuple[int,int]|None=None
    expected_dataset_identity:dict|None=None
    migration_window: object | None = field(default=None, repr=False, compare=False)
    window_registry_path: Path | None = field(default=None, repr=False, compare=False)
    window_platform_instance: object | None = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        if self.kind != "postgres":
            raise ValueError("source_backend_not_supported")

    def require_access(self, owner=None):
        from .source_window import require_source_access

        return require_source_access(self, owner)

    def window_status(self):
        from .source_window import source_window_status

        return source_window_status(self)

    def public_binding(self):
        # A source locator/password/path must never enter the manifest or audit log.
        return {'alias':self.alias,'instance':self.instance,'kind':self.kind,'timezone':self.timezone,'schemaHash':self.expected_schema_hash}


class SourceMismatch(ValueError):pass


MAX_EXPORT_BYTES=16*1024*1024
MAX_FIELD_BYTES=2*1024*1024
MAX_ROW_BYTES=4*1024*1024


def append_bounded(exported,row,used):
    size=len(canonical(row))
    if size>MAX_ROW_BYTES or used+size>MAX_EXPORT_BYTES:raise SourceMismatch('source_scope_requires_explicit_segmented_export')
    exported.append(row)
    return used+size


def pg_cell(value,kind,bits=None,server_encoding='UTF8'):
    if value is None:return {'storageType':kind,'null':True}
    if kind in ('numeric','decimal'):
        return {'storageType':kind,'text':value,'storedDecimalExact':True,'originalInputKnown':False}
    if kind in ('real','double precision'):
        return {'storageType':kind,'text':value,'ieee754Hex':bits,'storedDecimalExact':False,'originalInputKnown':False}
    return {'storageType':kind,'text':value,'originalInputKnown':False,'originalStoredTextValue':True,'originalTextBytes':kind in ('text','character varying') and server_encoding=='UTF8'}




def schema_digest(schema):return sha(canonical(schema))


class PgSnapshot:
    async def schema(self, conn, check=None):
        async def execute(*args, **kwargs):
            if check:
                check()
            return await conn.execute(*args, **kwargs)

        rows = await (
            await execute(
                "SELECT table_name,column_name,data_type,udt_name,numeric_precision,numeric_scale,character_maximum_length,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"
            )
        ).fetchall()
        schema={name:[] for name in TABLES}
        for row in rows:
            if row['table_name'] in TABLES:schema[row['table_name']].append({'name':row['column_name'],'type':row['data_type'],'nativeType':row['udt_name'],'precision':row['numeric_precision'],'scale':row['numeric_scale'],'length':row['character_maximum_length'],'nullable':row['is_nullable']=='YES'})
            elif row['table_name']=='users' and row['column_name']=='id':schema['__owner_identity']=[{'name':'id','type':row['data_type'],'nativeType':row['udt_name'],'precision':row['numeric_precision'],'scale':row['numeric_scale'],'length':row['character_maximum_length'],'nullable':row['is_nullable']=='YES'}]
        candidates = await (
            await execute(
                "SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN ('trade_orders_new','fund_transactions_new') ORDER BY c.relname"
            )
        ).fetchall()
        schema['__migration_candidates']=[row['name'] for row in candidates]
        # pg_catalog exposes structure independently of information_schema's
        # SELECT-privilege filter. No unexported family contents are queried.
        try:
            async with conn.transaction():
                family_rows = await (
                    await execute(
                        """SELECT c.relname table_name,a.attname name,pg_catalog.format_type(a.atttypid,a.atttypmod) type
                    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
                    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY(%s)
                    ORDER BY c.relname,a.attnum""",
                        (list(FAMILY_TABLES),),
                    )
                ).fetchall()
            catalog={}
            for row in family_rows:
                catalog.setdefault(row['table_name'],[])
                if row['name'] is not None:catalog[row['table_name']].append({'name':row['name'],'type':row['type']})
            schema['__financial_families']=structure_evidence(catalog,method='postgres_catalog_structure_only')
        except psycopg.errors.InsufficientPrivilege:
            schema['__financial_families']=structure_evidence({},method='postgres_catalog_permission_unavailable',known=False)
        try:
            async with conn.transaction():
                security=await(await execute("SELECT c.relname name,c.relrowsecurity enabled FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(%s)",(['account_financing_policy','account_financing_requests'],))).fetchall()
            schema['__financing_row_security']={'known':True,'tables':{row['name']:row['enabled'] for row in security}}
        except psycopg.errors.InsufficientPrivilege:
            schema['__financing_row_security']={'known':False,'tables':{}}
        return schema

    async def export(self, definition, owner, *, after_table=None):
        definition.require_access(owner)
        if owner not in definition.owners:raise SourceMismatch('source_owner_not_allowlisted')
        async with await psycopg.AsyncConnection.connect(
            definition.locator,
            autocommit=True,
            row_factory=dict_row,
            connect_timeout=5,
            options="-c statement_timeout=30000 -c lock_timeout=2000",
        ) as conn:

            async def execute(*args, **kwargs):
                definition.require_access(owner)
                return await conn.execute(*args, **kwargs)

            await execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            try:
                identity = await (
                    await execute(
                        "SELECT current_database() database,current_user role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,current_setting('data_directory') directory,current_setting('transaction_read_only') read_only,current_setting('transaction_isolation') isolation,current_setting('server_encoding') encoding,pg_current_snapshot()::text snapshot"
                    )
                ).fetchone()
                if identity['database']!=definition.expected_database or identity['role']!=definition.expected_role or Path(identity['directory']).resolve()!=definition.expected_data_directory.resolve() or identity['read_only']!='on' or identity['isolation']!='repeatable read':raise SourceMismatch('source_instance_identity_mismatch')
                dataset=None
                try:
                    async with conn.transaction():
                        control = await (
                            await execute("SELECT system_identifier::text FROM pg_control_system()")
                        ).fetchone()
                        dataset={'kind':'postgres','systemIdentifier':control['system_identifier'],'databaseOid':identity['database_oid']}
                except psycopg.errors.InsufficientPrivilege:
                    pass
                dataset_verified=bool(dataset and definition.expected_dataset_identity==dataset)
                if dataset and definition.expected_dataset_identity and not dataset_verified:raise SourceMismatch('source_persistent_dataset_identity_mismatch')
                schema = await self.schema(conn, check=lambda: definition.require_access(owner))
                if schema_digest(schema)!=definition.expected_schema_hash:raise SourceMismatch('source_schema_changed')
                owners = (
                    await (await execute("SELECT id FROM users WHERE id=%s LIMIT 2", (owner,))).fetchall()
                    if schema.get("__owner_identity")
                    else []
                )
                owner_verified=len(owners)==1
                tables = {}
                unknown = []
                used = len(canonical(schema)) + 4096
                for name, (allowed, scope) in TABLES.items():
                    columns=schema[name]
                    unknown.extend(name+'.'+c['name'] for c in columns if c['name'] not in allowed.split() and c['name'] not in EXCLUDED_COLUMNS.get(name,{}))
                    selected=[c for c in columns if c['name'] in allowed.split()]
                    if not selected:tables[name]={'present':False,'columns':[],'rows':[]};continue
                    expressions=[]
                    for index,col in enumerate(selected):
                        column=sql.Identifier('r',col['name'])
                        expressions.append(sql.SQL('CASE WHEN octet_length({}::text)>{} THEN NULL ELSE {}::text END AS {}').format(column,sql.Literal(MAX_FIELD_BYTES),column,sql.Identifier('v'+str(index))))
                        expressions.append(sql.SQL('(octet_length({}::text)>{}) AS {}').format(column,sql.Literal(MAX_FIELD_BYTES),sql.Identifier('large'+str(index))))
                        if col['type'] in ('real','double precision'):
                            function='float4send' if col['type']=='real' else 'float8send'
                            expressions.append(sql.SQL("encode({}({}),'hex') AS {}").format(sql.Identifier(function),column,sql.Identifier('b'+str(index))))
                    owned=sql.SQL('r.user_id=%s') if scope=='user_id' else sql.SQL('EXISTS(SELECT 1 FROM trade_orders o WHERE o.id=r.order_id AND o.user_id=%s)')
                    query=sql.SQL('SELECT {} FROM {} r WHERE {} LIMIT 100001').format(sql.SQL(',').join(expressions),sql.Identifier(name),owned)
                    exported=[]
                    async with conn.cursor(name="alcor_source_" + uuid4().hex) as cursor:
                        cursor.itersize=4
                        definition.require_access(owner)
                        await cursor.execute(query,(owner,))
                        while True:
                            definition.require_access(owner)
                            batch = await cursor.fetchmany(4)
                            if not batch:
                                break
                            for row in batch:
                                if len(exported) >= 100000 or any(
                                    row["large" + str(i)] for i in range(len(selected))
                                ):
                                    raise SourceMismatch("source_scope_requires_explicit_segmented_export")
                                value = {
                                    c["name"]: pg_cell(
                                        row["v" + str(i)],
                                        c["type"],
                                        row.get("b" + str(i)),
                                        identity["encoding"],
                                    )
                                    for i, c in enumerate(selected)
                                }
                                used = append_bounded(exported, value, used)
                    exported.sort(key=canonical)
                    tables[name]={'present':True,'columns':columns,'rows':exported}
                    if after_table:await after_table(name)
                return {'format':'legacy-storage-snapshot/1','source':{**definition.public_binding(),'owner':owner,'ownerVerified':owner_verified,'ownerIdentityEvidence':{'table':'users','column':'id','matchedId':owner if owner_verified else None},'datasetIdentityVerified':dataset_verified,'datasetIdentity':dataset,'datasetIdentityAssurance':'persistent_cluster_identifier_and_database_oid' if dataset_verified else 'not_verified','serverEncoding':identity['encoding'],'financingRowSecurity':schema.get('__financing_row_security',{'known':True,'tables':{name:False for name in ('account_financing_policy','account_financing_requests')}}),'financialFamilyEvidence':captured_family_evidence(schema['__financial_families'],tables),'unresolvedMigrationTables':schema['__migration_candidates'],'snapshotToken':identity['snapshot'],'readOnly':True,'isolation':'repeatable read','unknownColumns':unknown},'tables':tables}
            finally:
                await conn.execute("ROLLBACK")


