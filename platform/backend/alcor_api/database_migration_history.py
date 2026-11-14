"""Import original historical registrations without replaying current positions or cash.

Original values, unknown fees, suspended intentions and cash adjustments retain their
source meaning. This is history evidence, never proof of broker execution or paid cash.
"""
import asyncio
import hashlib
from collections import OrderedDict
from datetime import UTC,datetime
from decimal import Decimal
from uuid import UUID,uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .backups import BackupFailure,private_read
from .connection_access import require_connection_verification
from .connections import Vault
from .database_migration_capture import canonical,sha
from .database_migration_connections import MigrationConnections,fingerprint
from .database_migration_jobs import guard,public_task
from .database_migration_portfolio import PortfolioImportInput,read_plan,source_connection,complete_on_connection
from .security import Identity,lock_mutation_identity


def observed_time(value,zone):
    if not value:return None
    try:
        stamp=datetime.fromisoformat(value)
        return (stamp if stamp.tzinfo else stamp.replace(tzinfo=ZoneInfo(zone))).astimezone(UTC).isoformat()
    except (ValueError,TypeError):return None


def cells(snapshot,name):
    return [{key:None if value.get('null') else value['text'] for key,value in row.items()} for row in snapshot['tables'][name]['rows']]


def packet(plan,portfolio):
    raw=plan['raw_snapshot'];maps=portfolio['maps'];financial=plan.get('financial')
    if not financial:raise BackupFailure('原交易与资金范围缺失')
    orders=cells(raw,'trade_orders');funds=cells(raw,'fund_transactions')
    normalized={row['id']:row for row in financial['orders']}
    for name,rows in (('交易',orders),('资金',funds)):
        ids=[row.get('id') for row in rows]
        if any(not value for value in ids) or len(ids)!=len(set(ids)):raise BackupFailure('原'+name+'编号缺失或重复')
    if set(normalized)!={row['id'] for row in orders}:raise BackupFailure('原交易转换范围不一致')
    for row in orders:
        mapped=normalized[row['id']]
        if row.get('record_id') not in maps['records'] or mapped['sourceAccountId'] not in maps['accounts']:
            raise BackupFailure('原交易的证券或账户归属尚未核对')
        if row['status'] not in ('filled','pending','cancelled','canceled','expired','rejected'):raise BackupFailure('原交易状态不可表达')
    # Preserve all fee and correction evidence alongside the exact PG cells.
    return {'format':'registered-history/1','source_instance':plan['portfolio']['source_instance'],
        'source_owner':plan['source_owner'],'source_manifest_sha256':plan['source_manifest_sha256'],
        'timezone':plan['timezone'],'maps':maps,'orders':orders,'funds':funds,'normalized_orders':normalized,
        'raw_snapshot':raw,'fee_policy':'retain_unverified','historical_coverage_verified':False}


async def submit(db,who,conversion_id,data:PortfolioImportInput,*,kind='database.migration.history'):
    service=MigrationConnections(db)
    intent={'kind':kind,'conversion_id':str(conversion_id),'plan_sha256':data.plan_sha256,'runtime_binding':service.runtime_binding(),'confirmed_registered_values':True}
    hashed=fingerprint(intent)
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who);await require_connection_verification(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
        if prior:
            if prior['kind']==kind and prior['payload'].get('_admission_cancelled'):return public_task(prior)
            if prior['fingerprint']!=hashed:raise HTTPException(409,'原请求编号已用于其他操作')
            return public_task(prior)
        conversion=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.convert' FOR SHARE",(conversion_id,who.id))).fetchone()
        if not conversion or conversion['status']!='succeeded' or (conversion['result'] or {}).get('plan_sha256')!=data.plan_sha256:raise HTTPException(409,'原转换计划未核对')
        imported=await(await conn.execute('SELECT * FROM database_migration_portfolio_imports WHERE owner_id=%s AND conversion_id=%s',(who.id,conversion_id))).fetchone()
        if not imported:raise HTTPException(409,'请先导入本次持仓与自选')
        if kind=='database.migration.complete':
            # Reopening the page or a second tab attaches to the accepted job.
            # Only a terminal, incomplete job admits a new continuation.
            active=await(await conn.execute("""SELECT * FROM tasks WHERE owner_id=%s AND kind=%s
                AND payload->>'conversion_id'=%s AND status IN ('queued','running','cancel_requested')
                ORDER BY created_at DESC,id DESC LIMIT 1""",(who.id,kind,str(conversion_id)))).fetchone()
            if active:return public_task(active)
            completed=await(await conn.execute('SELECT t.* FROM database_migration_completion_imports i JOIN tasks t ON t.id=i.task_id WHERE i.owner_id=%s AND i.conversion_id=%s',(who.id,conversion_id))).fetchone()
            if completed:return public_task(completed)
        receipt_table='database_migration_completion_imports' if kind=='database.migration.complete' else 'database_migration_history_imports'
        if await(await conn.execute('SELECT 1 FROM '+receipt_table+' WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,imported['source_instance'],imported['source_owner']))).fetchone():raise HTTPException(409,'此来源已经导入，请读取原记录')
        if await(await conn.execute("SELECT 1 FROM tasks WHERE kind LIKE 'database.migration.%' AND status IN ('queued','running','cancel_requested') LIMIT 1")).fetchone():raise HTTPException(409,'已有迁移任务正在执行')
        try:packet(await asyncio.to_thread(read_plan,db.settings,conversion),imported['result'])
        except (BackupFailure,OSError,KeyError,ValueError) as error:raise HTTPException(422,str(error) if isinstance(error,BackupFailure) else '原转换计划不可用') from None
        source=await(await conn.execute('SELECT revision,password_ciphertext FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or str(source['revision'])!=conversion['payload']['source_revision']:raise HTTPException(409,'来源配置已变化')
        intent.update(preparation_id=conversion['payload']['preparation_id'],source_revision=str(source['revision']),portfolio_task_id=str(imported['task_id']),
            _session_hash=who.token_hash,_session_client='legacy-web' if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else 'new-web',
            _vault_fingerprint=hashlib.sha256(Vault(db.settings.connection_secret_dir,read_only=True).key()).hexdigest() if source['password_ciphertext'] else None,_archive=conversion['payload']['_archive'])
        row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,%s,'queued',%s) RETURNING *",(uuid4(),who.id,data.request_id,hashed,kind,Jsonb(intent)))).fetchone()
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(row['id'],))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.history.submitted',%s,%s)",(who.id,str(row['id']),data.request_id))
        return public_task(row)


async def committed(db,task,*,finalize=True):
    async with db.connection() as conn,conn.transaction():
        current=await(await conn.execute('SELECT * FROM tasks WHERE id=%s FOR UPDATE',(task['id'],))).fetchone()
        row=await(await conn.execute('SELECT result,fingerprint FROM database_migration_history_imports WHERE owner_id=%s AND request_id=%s',(task['owner_id'],task['request_id']))).fetchone()
        if row:
            if not current or row['fingerprint']!=task['fingerprint'] or current['fingerprint']!=task['fingerprint'] or current['owner_id']!=task['owner_id']:raise BackupFailure('原历史导入请求不一致')
            if finalize and current['status']!='succeeded':await complete_on_connection(conn,task,row['result'])
            return row['result']


async def execute(db,task,*,finalize=True):
    if await committed(db,task,finalize=finalize):return
    source=await guard(db,task)
    async with db.connection() as conn:
        conversion=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.convert'",(UUID(task['payload']['conversion_id']),task['owner_id']))).fetchone()
        imported=await(await conn.execute('SELECT * FROM database_migration_portfolio_imports WHERE owner_id=%s AND task_id=%s AND conversion_id=%s',(task['owner_id'],UUID(task['payload']['portfolio_task_id']),UUID(task['payload']['conversion_id'])))).fetchone()
    if not conversion or not imported:raise BackupFailure('原转换或持仓导入记录不存在')
    plan=await asyncio.to_thread(read_plan,db.settings,conversion)
    if conversion['result']['plan_sha256']!=task['payload']['plan_sha256']:raise BackupFailure('转换计划已变化')
    original=packet(plan,imported['result'])
    # Reuse the same physical source identity guard and freeze every imported
    # financial table, not just current positions, during the target commit.
    from .database_migration_retry import attempt_path
    from .database_migration_transform import FrozenTables
    from .database_migration_capture import CaptureBudget
    import json,threading
    folder=attempt_path(db.settings,task['payload']['_archive']['archive_task'],task['payload']['_archive']['archive_attempt'])/'source'
    raw_manifest=private_read(folder/'manifest.json',16*1024**2)
    if sha(raw_manifest)!=plan['source_manifest_sha256']:raise BackupFailure('原历史归档清单已变化')
    manifest=json.loads(raw_manifest)
    frozen=FrozenTables(folder,manifest,threading.Event(),CaptureBudget(128*1024**2,0,60))
    names=set(plan['raw_snapshot']['tables'])|{'watch_groups'}
    for table in manifest['tables']:
        if table['schema']==plan['portfolio']['source_schema'] and table['name'] in names:frozen.rows(table['schema'],table['name'])
    guarded={**plan['portfolio'],'source_tables':[{key:t[key] for key in ('schema','name','rows','multiset_sha256')} for t in manifest['tables'] if t['schema']==plan['portfolio']['source_schema'] and t['name'] in names]}
    old=await source_connection(db,task,source,guarded)
    try:
        await guard(db,task,{'phase':'history_import','processed':0,'total':len(original['orders'])+len(original['funds']),'unit':'records'})
        async with db.connection() as conn,conn.transaction():
            from .worker import owned_row
            from .personal_data_transfer import PersonalDataTransfer
            actor=await(await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.token_hash=%s',(task['owner_id'],task['payload']['_session_hash']))).fetchone()
            if not actor:raise BackupFailure('原迁移授权已失效')
            who=Identity(**actor,token_hash=task['payload']['_session_hash'],csrf='')
            if task['payload']['_session_client']=='legacy-web':who.legacy_client=True
            await PersonalDataTransfer(db).lock(conn,who)
            # Source IDs stay immutable; registered history never mutates the
            # already imported position, executes a pending order or posts cash.
            for old_id,target in original['maps']['records'].items():
                if not await(await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s AND id=%s',(who.id,target))).fetchone():raise BackupFailure('导入证券映射已变化')
            lease=await owned_row(conn,task)
            if not lease or lease['status']!='running':raise BackupFailure('历史导入已停止')
            current_source=await(await conn.execute('SELECT revision FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
            if not current_source or str(current_source['revision'])!=task['payload']['source_revision']:raise BackupFailure('来源配置已变化')
            result={'conversion_id':task['payload']['conversion_id'],'phase':'history_imported','business_written':True,'cutover_ready':False,'history_imported':True,'cash_history_imported':True,'cash_posted':False,'identity_switched':False,
                'counts':{'orders':len(original['orders']),'funds':len(original['funds']),'independent_funds':sum(not r['id'].startswith('fund-order-') for r in original['funds']),
                          'recorded_pnl':sum(r.get('realized_pnl') is not None and r['status']=='filled' and r['side'] in ('sell','dividend') for r in original['orders'])},
                'original_values_preserved':True,'fee_policy':'retain_unverified','created_at':datetime.now(UTC).isoformat()}
            await conn.execute('INSERT INTO database_migration_history_imports(owner_id,request_id,task_id,portfolio_task_id,conversion_id,source_instance,source_owner,source_sha256,fingerprint,originals,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (who.id,task['request_id'],task['id'],imported['task_id'],conversion['id'],imported['source_instance'],imported['source_owner'],sha(canonical(original)),task['fingerprint'],Jsonb(original),Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.history.imported',%s,%s)",(who.id,str(task['id']),task['request_id']))
            if finalize:await complete_on_connection(conn,task,result)
    finally:await old.rollback();await old.close()


async def registered_orders(conn,owner,*,native_records=None):
    from .legacy_order_projection import native_fields

    rows=await(await conn.execute('SELECT originals,source_sha256,source_instance,source_owner FROM database_migration_history_imports WHERE owner_id=%s ORDER BY created_at,request_id',(owner,))).fetchall()
    output=[]
    for stored in rows:
        packet=stored['originals'];maps=packet['maps']
        projection=native_fields(stored,native_records) if native_records is not None else None
        for row in packet['orders']:
            normalized=packet['normalized_orders'][row['id']];rid=maps['records'][row['record_id']]
            numeric=lambda key:Decimal(row[key]) if row.get(key) is not None else None
            output.append({'id':row['id'],'originalOrderNo':row.get('order_no'),'orderNo':row.get('order_no'),'orderNoSource':'source_original',
                'recordId':rid,'market':row['market'],'code':row['code'],'name':row['name'],'side':row['side'],'status':'imported_suspended' if row['status']=='pending' else row['status'],
                'qty':numeric('qty'),'price':numeric('price'),'amount':numeric('amount'),'fees':numeric('fees'),'registeredFees':numeric('fees'),
                'feeSource':normalized['feeAuthority'],'actualFeeKnown':normalized['feeAuthority'] in ('owner_recorded','broker_reported'),
                'feeAuthority':normalized['feeAuthority'],'feeBreakdown':None,'feeBreakdownSource':'unavailable',
                'currency':normalized['currency'],'settlementCurrency':normalized['settlementCurrency'],'settlementAmount':numeric('settlement_amount'),
                'realizedPnl':numeric('realized_pnl'),'realizedPnlAuthority':'source_registered_unverified',
                'positionQtyBefore':numeric('position_qty_before'),'positionQtyAfter':numeric('position_qty_after'),'positionCostBefore':numeric('position_cost_before'),'positionCostAfter':numeric('position_cost_after'),
                'tradedAt':normalized['occurredAt'],'createdAt':observed_time(row.get('created_at'),packet['timezone']),'broker':row.get('broker'),'brokerAccountId':maps['accounts'][normalized['sourceAccountId']],
                'brokerAccountIdSource':'owner_confirmed_source_mapping','accountKind':normalized['accountKind'],'accountMarket':'CN' if normalized['settlementCurrency']=='CNY' and row['market']=='HK' else row['market'],
                'note':row.get('note') or '', 'orderType':row.get('order_type'),'triggerPrice':numeric('trigger_price'),'tif':row.get('tif'),'expiresAt':row.get('expires_at'),'session':row.get('session'),
                'registrationContextKnown':row.get('order_type') is not None,'executionModel':'source_registered_history','brokerExecution':False,'cancellable':False,'apiManaged':False,'historyLocked':True,'revision':int(normalized['version']) if normalized['version'].isdigit() else 1,
                'sourceInstance':packet['source_instance'],'sourceOwner':packet['source_owner'],'historicalCoverageKnown':False})
            if projection is not None:
                output[-1]['migrationMappedBrokerAccountId']=output[-1]['brokerAccountId']
                output[-1].update(projection[row['id']])
    return output


# Imported originals are immutable sealed packets, but re-parsing every packet
# on each funds read kept the cash card empty for seconds after refresh.
_registered_funds_cache = OrderedDict()
_REGISTERED_FUNDS_LIMIT = 32


def _registered_funds_for(data):
    output=[]
    orders={row['id']:row for row in data['orders']}
    for row in data['funds']:
        original_id=row['id'];order_id=original_id[len('fund-order-'):] if original_id.startswith('fund-order-') else None
        order=orders.get(order_id);mapped=data['normalized_orders'].get(order_id)
        amount=Decimal(row['amount']) if row.get('amount') is not None else None
        # The original automatic projection is displayed once. It is never
        # added again to canonical cash postings or recreated from the fill.
        output.append({'id':original_id,'currency':row['currency'],'type':row['type'],'amount':float(amount) if amount is not None else None,
            'registeredAmount':str(amount) if amount is not None else None,'direction':int(row['direction']) if row.get('direction') is not None else None,
            'note':row.get('note') or '', 'occurredAt':observed_time(row.get('occurred_at'),data['timezone']),'createdAt':observed_time(row.get('created_at'),data['timezone']),
            'sourceOrderId':order_id,'stockCode':order.get('code') if order else None,'stockName':order.get('name') if order else None,'stockMarket':order.get('market') if order else None,
            'accountKind':mapped['accountKind'] if mapped else 'unknown','accountId':data['maps']['accounts'].get(mapped['sourceAccountId']) if mapped else None,
            'amountAuthority':'source_registered_unverified','actualFeeKnown':mapped['feeAuthority'] in ('owner_recorded','broker_reported') if mapped else None,
            'independentDeletionSupported':False,'cashPosted':False,'sourceInstance':data['source_instance']})
    return output


async def registered_funds(conn,owner):
    stored=await(await conn.execute('SELECT originals,request_id,source_sha256 FROM database_migration_history_imports WHERE owner_id=%s ORDER BY created_at,request_id',(owner,))).fetchall()
    output=[]
    for batch in stored:
        key=(owner,str(batch['request_id']),batch['source_sha256'])
        rows=_registered_funds_cache.get(key)
        if rows is None:
            rows=_registered_funds_for(batch['originals'])
            _registered_funds_cache[key]=rows
            while len(_registered_funds_cache)>_REGISTERED_FUNDS_LIMIT:
                _registered_funds_cache.popitem(last=False)
        else:
            _registered_funds_cache.move_to_end(key)
        # Cached rows are read-only projections; callers sort and filter into
        # new lists without mutating the rows.
        output.extend(rows)
    return output
