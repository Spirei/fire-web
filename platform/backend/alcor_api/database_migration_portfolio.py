"""Atomic registered portfolio import; no reconstructed trades, paid fees or cash postings."""
import asyncio
import re
from decimal import Decimal
import hashlib
import json
from datetime import UTC,datetime
from uuid import UUID,uuid4,uuid5,NAMESPACE_URL

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb
from pydantic import Field
from typing import Literal

from fastapi import HTTPException
from .backups import BackupFailure,private_read
from .backup_stream_storage import existing_directory
from .connection_access import require_connection_verification
from .connections import Vault,Connections
from .database_migration_connections import MigrationConnections,SourceConfig,fingerprint
from .database_migration_capture import canonical,sha
from .database_migration_jobs import guard,public_task
from .legacy_record_writes import TransactionDB
from .models import InputModel
from .security import Identity,lock_mutation_identity


class PortfolioImportInput(InputModel):
    request_id:UUID
    plan_sha256:str=Field(pattern='^[a-f0-9]{64}$')
    confirmed_registered_values:Literal[True]


def read_plan(settings,conversion):
    root=existing_directory(existing_directory(settings.backup_dir)/'database-migration-conversions')
    folder=existing_directory(existing_directory(root/str(conversion['id']))/('attempt-'+str(conversion['attempts'])))
    raw=private_read(folder/'conversion-plan.json',64*1024**2)
    if sha(raw)!=(conversion['result'] or {}).get('plan_sha256'):raise BackupFailure('转换计划已变化')
    return json.loads(raw)


async def submit(db,who,conversion_id,data):
    service=MigrationConnections(db)
    intent={'kind':'database.migration.portfolio','conversion_id':str(conversion_id),'plan_sha256':data.plan_sha256,'runtime_binding':service.runtime_binding(),'confirmed_registered_values':True}
    hashed=fingerprint(intent)
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who);await require_connection_verification(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
        if prior:
            if prior['kind']=='database.migration.portfolio' and prior['payload'].get('_admission_cancelled'):return public_task(prior)
            if prior['fingerprint']!=hashed:raise HTTPException(409,'原请求编号已用于其他操作')
            return public_task(prior)
        conversion=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.convert' FOR SHARE",(conversion_id,who.id))).fetchone()
        if not conversion or conversion['status']!='succeeded' or (conversion['result'] or {}).get('plan_sha256')!=data.plan_sha256:raise HTTPException(409,'请先完成并核对本次转换')
        source=await(await conn.execute('SELECT revision,password_ciphertext FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or str(source['revision'])!=conversion['payload']['source_revision']:raise HTTPException(409,'来源配置已变化')
        try:plan=await asyncio.to_thread(read_plan,db.settings,conversion)
        except (BackupFailure,OSError,KeyError,ValueError):raise HTTPException(422,'转换计划不可用，请核对原记录') from None
        portfolio=plan['portfolio']
        if not portfolio['ready']:raise HTTPException(409,'持仓、自选或账户映射尚未核对')
        if await(await conn.execute('SELECT 1 FROM database_migration_portfolio_imports WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,portfolio['source_instance'],portfolio['source_owner']))).fetchone():raise HTTPException(409,'此来源的持仓与自选已经导入，请读取原记录')
        if await(await conn.execute("SELECT 1 FROM tasks WHERE kind LIKE 'database.migration.%' AND status IN ('queued','running','cancel_requested') LIMIT 1")).fetchone():raise HTTPException(409,'已有迁移任务正在执行')
        for table in ('portfolio_records','broker_accounts','trade_ledger','cash_ledger_entries','internal_orders'):
            if await(await conn.execute(sql.SQL('SELECT 1 FROM {} WHERE owner_id=%s LIMIT 1').format(sql.Identifier(table)),(who.id,))).fetchone():raise HTTPException(409,'当前账号已有业务记录，不能覆盖导入')
        client='legacy-web' if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else 'new-web'
        intent.update(preparation_id=conversion['payload']['preparation_id'],source_revision=str(source['revision']),_session_hash=who.token_hash,_session_client=client,
            _vault_fingerprint=hashlib.sha256(Vault(db.settings.connection_secret_dir,read_only=True).key()).hexdigest() if source['password_ciphertext'] else None,
            _archive=conversion['payload']['_archive'])
        row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'database.migration.portfolio','queued',%s) RETURNING *",(uuid4(),who.id,data.request_id,hashed,Jsonb(intent)))).fetchone()
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(row['id'],))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.portfolio.submitted',%s,%s)",(who.id,str(row['id']),data.request_id))
        return public_task(row)


async def complete_on_connection(conn,task,result):
    await conn.execute("UPDATE tasks SET status='succeeded',result=%s,error_code=NULL,finished_at=clock_timestamp(),lease_until=NULL WHERE id=%s",(Jsonb(result),task['id']))
    await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'succeeded')",(task['id'],))


async def committed(db,task):
    async with db.connection() as conn,conn.transaction():
        original=await(await conn.execute('SELECT status,fingerprint,owner_id,request_id FROM tasks WHERE id=%s FOR UPDATE',(task['id'],))).fetchone()
        row=await(await conn.execute('SELECT result,fingerprint FROM database_migration_portfolio_imports WHERE owner_id=%s AND request_id=%s',(task['owner_id'],task['request_id']))).fetchone()
        if row:
            if not original or row['fingerprint']!=task['fingerprint'] or original['fingerprint']!=task['fingerprint'] or original['owner_id']!=task['owner_id'] or original['request_id']!=task['request_id']:raise BackupFailure('原导入请求内容不一致')
            # A proven commit cannot be relabeled cancelled by a late request.
            if original['status']!='succeeded':await complete_on_connection(conn,task,row['result'])
            return row['result']


async def source_connection(db,task,source,portfolio,*,security_only=False):
    config=SourceConfig.model_validate(source['config']);settings=db.settings
    password=Vault(settings.connection_secret_dir,read_only=True).decrypt(source['password_ciphertext'],'database-migration-source',settings.instance_id)
    address=await Connections(settings,db,None).address(config)
    values={'host':config.host,'port':config.port,'dbname':config.database,'user':config.username,'password':password,'sslmode':config.ssl_mode}
    if not config.host.startswith('/'):values['hostaddr']=address
    connection=await psycopg.AsyncConnection.connect(make_conninfo(**values),row_factory=dict_row,connect_timeout=5,
        options='-c search_path=pg_catalog -c timezone=UTC -c extra_float_digits=3 -c bytea_output=hex -c statement_timeout=30000 -c lock_timeout=3000')
    try:
        await connection.execute('SET TRANSACTION ISOLATION LEVEL '+('READ COMMITTED' if security_only else 'REPEATABLE READ'))
        identity=await(await connection.execute("SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,system_identifier::text AS system_identifier FROM pg_control_system()")).fetchone()
        if sha(canonical(identity|{'schema':config.schema_name}))!=task['payload']['_archive']['identities']['source']:raise BackupFailure('来源数据库身份已变化')
        # The original connection keeps business rows locked. Security cutover
        # needs a separate READ COMMITTED connection: table locks must precede
        # the snapshot used for TOTP counters and credential reads.
        if security_only:return connection
        tables=portfolio['source_tables']
        await connection.execute(sql.SQL('LOCK TABLE {} IN SHARE MODE').format(sql.SQL(',').join(sql.Identifier(item['schema'],item['name']) for item in tables)))
        for table in tables:
            hashes=[]
            async with connection.cursor(name='migration_'+uuid4().hex) as cursor:
                await cursor.execute(sql.SQL('SELECT row_to_json(t)::text AS value FROM ONLY {} t').format(sql.Identifier(table['schema'],table['name'])))
                while rows:=await cursor.fetchmany(256):
                    hashes.extend(hashlib.sha256(row['value'].encode()).digest() for row in rows)
                    if len(hashes)>100000:raise BackupFailure('来源范围超过导入预算')
            if len(hashes)!=table['rows'] or sha(b''.join(sorted(hashes)))!=table['multiset_sha256']:raise BackupFailure('来源持仓或分组已变化，请更新快照后再导入')
        return connection
    except BaseException:
        await connection.close();raise


async def execute(db,task):
    from .worker import owned_row
    prior=await committed(db,task)
    if prior:return
    source=await guard(db,task)
    async with db.connection() as conn:
        conversion=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.convert'",(UUID(task['payload']['conversion_id']),task['owner_id']))).fetchone()
    if not conversion:raise BackupFailure('原转换任务不存在')
    plan=read_plan(db.settings,conversion)
    if conversion['result']['plan_sha256']!=task['payload']['plan_sha256'] or not plan['portfolio']['ready']:raise BackupFailure('原转换计划已变化')
    portfolio=plan['portfolio'];old=await source_connection(db,task,source,portfolio)
    try:
        async with db.connection() as conn,conn.transaction():
            from .personal_data_transfer import PersonalDataTransfer
            from .broker_accounts import BrokerCreate,mutate_broker
            from .portfolio_records import PortfolioRecords
            from .watchlists import WatchGroups
            actor=await(await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.token_hash=%s',(task['owner_id'],task['payload']['_session_hash']))).fetchone()
            if not actor:raise BackupFailure('原导入授权已失效')
            who=Identity(**actor,token_hash=task['payload']['_session_hash'],csrf='')
            if task['payload']['_session_client']=='legacy-web':who.legacy_client=True
            await PersonalDataTransfer(db).lock(conn,who)
            for table in ('portfolio_records','broker_accounts','trade_ledger','cash_ledger_entries','internal_orders'):
                if await(await conn.execute(sql.SQL('SELECT 1 FROM {} WHERE owner_id=%s LIMIT 1').format(sql.Identifier(table)),(who.id,))).fetchone():raise BackupFailure('当前账号已有业务记录，导入未执行')
            before={'records':[],'accounts':[],'groups':[dict(row) for row in await(await conn.execute('SELECT id,name,kind,market,sort,visible,icon FROM watch_groups WHERE owner_id=%s ORDER BY id',(who.id,))).fetchall()]}
            bound=TransactionDB(db,conn);accounts={};records={};groups={};pending_icons=[]
            def child(label):return uuid5(task['request_id'],label)
            for index,row in enumerate(portfolio['accounts']):
                currencies=json.loads(row['currencies_json']) if row.get('currencies_json') else [row['currency']]
                from .trading import MARKET_CURRENCY
                for record in portfolio['records']:
                    if portfolio['record_accounts'].get(str(record['id']))==row['id']:
                        currency='CNY' if record['market']=='HK' and record.get('account_market')=='CN' else MARKET_CURRENCY.get(record['market'])
                        if currency and currency not in currencies:currencies.append(currency)
                command=BrokerCreate(request_id=child('account:'+row['id']),name=row['name'],provider_id=row['provider_id'],currency=row['currency'],currencies=currencies,account_kind=plan['account_classifications'].get(row['id']) or row['account_kind'])
                result=await mutate_broker(bound,who,'create','',command,connection=conn)
                if result['state']!='completed':raise BackupFailure('券商账户未通过核对，整批未导入')
                accounts[row['id']]=result['account_id']
            service=WatchGroups(bound)
            await service.mutate(who.id,'initialize',{},child('group-initialize'),authorization=who)
            current=await(await conn.execute("SELECT id,market FROM watch_groups WHERE owner_id=%s AND kind='market'",(who.id,))).fetchall();markets={row['market']:row['id'] for row in current}
            group_rows=[];kinds={}
            for row in portfolio['groups']:
                original=str(row['id']);kind=row['kind'];market=row.get('market') or ''
                identifier=markets.get(market) if kind=='market' else original if re.fullmatch('[A-Za-z0-9_-]{1,100}',original) else 'wg-'+uuid5(NAMESPACE_URL,portfolio['source_instance']+':'+portfolio['source_owner']+':'+original).hex
                groups[original]=identifier;kinds[original]=kind
                group_rows.append({'originalId':original,'targetId':identifier,'name':row['name'],'kind':kind,'market':market,'sort':int(row['sort']),'visible':int(row['visible'])})
                if row.get('icon'):pending_icons.append({'source_group_id':original,'target_group_id':identifier,'original_icon':row['icon']})
            if group_rows:await service.mutate(who.id,'source-import',{'groups':group_rows,'members':[]},child('groups'),authorization=who)
            record_service=PortfolioRecords(bound);members=[]
            for index,row in enumerate(portfolio['records']):
                old_id=str(row['id']);account=accounts.get(portfolio['record_accounts'].get(old_id),'');original_group=row.get('watch_group_id') or '';group=groups.get(original_group) if kinds.get(original_group)=='custom' else ''
                patch={'name':row['name'],'code':row['code'],'market':row['market'],'accountMarket':row.get('account_market') or '',
                    **{key:row.get(key) for key in ('price','cost','qty')},'group':row.get('group_name') or '','note':row.get('note') or '','source':row.get('source') or '',
                    'brokerAccountId':account,'watchGroupId':group or ''}
                target='r-'+uuid5(NAMESPACE_URL,portfolio['source_instance']+':'+portfolio['source_owner']+':'+old_id).hex
                preview=await record_service.preview(who.id,'create',patch,authorization=who,source_create_id=target)
                result=await record_service.confirm(who.id,preview['previewId'],child('record:'+old_id),authorization=who)
                # Registering the current source balance does not certify an empty past.
                saved=await(await conn.execute("UPDATE portfolio_records SET history_state='unknown' WHERE owner_id=%s AND id=%s RETURNING revision",(who.id,target))).fetchone()
                records[old_id]=target
                members.append({'originalRecordId':old_id,'recordId':target,'groupOriginalId':original_group if group else '',
                    'sort':int(row.get('watch_group_sort') or 0),'expectedRevision':saved['revision'],'sourceOrder':None,'sourceUpdatedAt':row.get('updated_at')})
                if index%10==0:await guard(db,task,{'phase':'portfolio_import','processed':index+1,'total':len(portfolio['records']),'unit':'records'})
            await service.mutate(who.id,'source-import',{'groups':group_rows,'members':members},child('members'),authorization=who)
            await guard(db,task)
            current_source=await(await conn.execute('SELECT revision FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
            if not current_source or str(current_source['revision'])!=task['payload']['source_revision']:raise BackupFailure('来源配置已变化，整批未导入')
            lease=await owned_row(conn,task)
            if not lease or lease['status']!='running':raise BackupFailure('导入已停止，未提交业务数据')
            result={'phase':'portfolio_imported','scope':'registered_portfolio_only','business_written':True,'cutover_ready':False,
                'source_revision':task['payload']['source_revision'],'conversion_id':task['payload']['conversion_id'],
                'counts':{'records':len(records),'holdings':sum(row.get('qty') is not None and Decimal(row['qty'])>0 for row in portfolio['records']),'accounts':len(accounts),'groups':len(groups)},
                'maps':{'records':records,'accounts':accounts,'groups':groups},'pending_icons':pending_icons,
                'history_imported':False,'cash_posted':False,'identity_switched':False,'original_costs_preserved':True,'created_at':datetime.now(UTC).isoformat()}
            await conn.execute('INSERT INTO database_migration_portfolio_imports(owner_id,request_id,task_id,conversion_id,source_instance,source_owner,fingerprint,plan_sha256,before_image,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (who.id,task['request_id'],task['id'],conversion['id'],portfolio['source_instance'],portfolio['source_owner'],task['fingerprint'],task['payload']['plan_sha256'],Jsonb(before),Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.portfolio.imported',%s,%s)",(who.id,str(task['id']),task['request_id']))
            await complete_on_connection(conn,task,result)
    finally:
        await old.rollback();await old.close()
