"""Versioned personal JSON transfer; never a database restore or ledger upsert."""
import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .legacy_record_writes import TransactionDB
from .portfolio_records import PortfolioRecords
from .security import lock_mutation_identity

LIMITS={'records':5000,'tradeOrders':20000,'activities':50000,'watchGroups':500,'fundTransactions':20000,'userSettings':1,'celebs':500}
COLUMNS={'records': ['account_market', 'code', 'cost', 'group_name', 'id', 'market', 'name', 'note', 'price', 'qty', 'source', 'updated_at', 'user_id', 'watch_group_id'], 'tradeOrders': ['amount', 'broker', 'code', 'created_at', 'expires_at', 'fees', 'id', 'market', 'name', 'note', 'order_no', 'order_type', 'position_cost_after', 'position_cost_before', 'position_qty_after', 'position_qty_before', 'price', 'qty', 'realized_pnl', 'record_id', 'session', 'settlement_amount', 'settlement_currency', 'side', 'status', 'tif', 'traded_at', 'trigger_price', 'trigger_status', 'user_id'], 'activities': ['action', 'cost', 'created_at', 'id', 'market', 'price', 'qty', 'stock_code', 'stock_name', 'user_id'], 'watchGroups': ['created_at', 'icon', 'id', 'kind', 'market', 'name', 'sort', 'user_id', 'visible'], 'fundTransactions': ['amount', 'created_at', 'currency', 'direction', 'id', 'note', 'occurred_at', 'type', 'user_id'], 'userSettings': ['fire', 'user_id'], 'celebs': ['avatar', 'cik', 'created_at', 'enabled', 'entity', 'holdings_json', 'id', 'name', 'refresh_hours', 'returns_json', 'sort', 'source_kind', 'source_label', 'stock_icons_json', 'title', 'trades_json', 'updated_at']}
DOMAINS=set(LIMITS)|{'profile','siteSettings'}


def encoded(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False,default=lambda x:x.isoformat() if isinstance(x,datetime) else str(x)).encode()


def digest(value):return hashlib.sha256(encoded(value)).hexdigest()


def identifier(raw):
    try:return str(UUID(str(raw)))
    except (ValueError,TypeError,AttributeError):raise HTTPException(400,'操作编号无效') from None



def validate_manifest(payload,data,counts):
    # Historical v1/v2 files may omit a manifest. A supplied declaration cannot
    # override missing data or be ignored by mapped-domain-import.
    if 'manifest' not in payload:return
    manifest=payload['manifest']
    if not isinstance(manifest,dict):raise HTTPException(422,'备份manifest须为对象')
    if 'portable' in manifest:
        if type(manifest['portable']) is not bool:raise HTTPException(422,'备份portable声明须为布尔值')
        if manifest['portable'] is not True:raise HTTPException(422,'此备份明确不完整，不能作为可完整导入的个人备份')
    if 'blocked' in manifest:
        if not isinstance(manifest['blocked'],list):raise HTTPException(422,'备份blocked声明须为数组')
        if manifest['blocked']:raise HTTPException(422,'此备份含未解决的完整性条件，不能导入')
    if 'counts' not in manifest:return
    declared=manifest['counts']
    if not isinstance(declared,dict) or set(declared)-DOMAINS:raise HTTPException(422,'备份counts含无法核对的数据域')
    nickname=data.get('profile',{}).get('nickname')
    # The frozen Web manifest counts a nonempty nickname as one profile, not
    # the number of keys. Other old manifest metadata stays opaque.
    profile_count=0 if nickname is None or nickname is False or isinstance(nickname,(str,int,float,Decimal)) and not nickname else 1
    actual={**counts,'siteSettings':len(data.get('siteSettings',{})),'profile':profile_count}
    for key,value in declared.items():
        if type(value) is not int or value<0:raise HTTPException(422,'备份条数须为非负整数')
        if value!=actual[key]:raise HTTPException(422,f'备份{key}声明条数与原数据不一致')


def validate(payload):
    if not isinstance(payload,dict) or payload.get('format')!='fire-site-backup' or type(payload.get('version')) is not int or payload['version'] not in (1,2):raise HTTPException(422,'不是有效的个人备份文件')
    if len(encoded(payload))>10485760:raise HTTPException(413,'个人备份超过10MiB')
    data=payload.get('data')
    if not isinstance(data,dict) or set(data)-DOMAINS:raise HTTPException(422,'备份含未知数据域')
    counts={}
    for key,limit in LIMITS.items():
        rows=data.get(key,[])
        if not isinstance(rows,list) or len(rows)>limit or any(not isinstance(r,dict) for r in rows):raise HTTPException(422,f'{key}格式或条数无效')
        if any(set(row)-set(COLUMNS[key]) for row in rows):raise HTTPException(422,f'{key}含未知原字段')
        ids=[str(row.get('id','')) for row in rows] if key!='userSettings' else []
        if ids and (not all(ids) or len(set(ids))!=len(ids)):raise HTTPException(422,f'{key}原ID缺失或重复')
        counts[key]=len(rows)
    if sum(counts.values())>75000:raise HTTPException(413,'备份超过75000行')
    for key in ('profile','siteSettings'):
        if not isinstance(data.get(key,{}),dict):raise HTTPException(422,f'{key}格式无效')
    if set(data.get('profile',{}))-{'nickname'}:raise HTTPException(422,'profile包含未知原字段')
    if len(data.get('siteSettings',{}))>500:raise HTTPException(422,'站点字段超过500项')
    validate_manifest(payload,data,counts)
    return data,counts


def fund_semantics(view):
    return {key:value for key,value in view.items() if key not in ('preview','cashPreview','previewId','sourceId','expiresAt')}


class PersonalDataTransfer:
    def __init__(self,db):self.db=db

    async def lock(self,conn,who):
        from .broker_accounts import serialize_brokers
        await conn.execute('SELECT pg_advisory_xact_lock(67132005)')
        await serialize_brokers(conn,who.id)
        await lock_mutation_identity(conn,who,require_admin=False)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",('personal-transfer:'+str(who.id),))

    def binding(self,who):return PortfolioRecords(self.db).authorization_binding(who.id,who)

    async def revisions(self,conn,who):
        # Hash full relevant owner rows, including tombstones, not just a page.
        result={}
        for key,table,column in [('records','portfolio_records','owner_id'),('groups','watch_groups','owner_id'),('accounts','broker_accounts','owner_id'),('cash','cash_ledger_entries','owner_id'),('trades','trade_ledger','owner_id'),('profile','users','id'),('profileFields','user_profiles','user_id'),('fire','fire_planning_settings','owner_id'),('orderDeclarations','personal_order_declarations','owner_id')]:
            rows=await(await conn.execute(f'SELECT to_jsonb(t)::text AS value FROM {table} t WHERE {column}=%s ORDER BY to_jsonb(t)::text',(who.id,))).fetchall()
            result[key]=digest([row['value'] for row in rows])
        if who.role=='admin':
            for table in ('site_settings','celeb_scope','celeb_heads'):
                rows=await(await conn.execute(f'SELECT to_jsonb(t)::text AS value FROM {table} t ORDER BY to_jsonb(t)::text')).fetchall()
                result[table]=digest([row['value'] for row in rows])
        return result

    async def portable_guards(self,conn,who):
        blocked=[]
        for table in ('trade_ledger','trade_amendments','trade_fee_details','cash_ledger_entries','internal_orders','broker_position_transfers'):
            present=await(await conn.execute('SELECT to_regclass(%s) AS relation',('public.'+table,))).fetchone()
            if present['relation']:
                exists=await(await conn.execute(f'SELECT 1 FROM {table} WHERE owner_id=%s LIMIT 1',(who.id,))).fetchone()
                if exists:blocked.append({'domain':'ledger','reason':'modern_history_not_representable','table':table})
        return blocked

    async def export_on_connection(self,conn,who):
        records=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 5001',(who.id,))).fetchall()
        groups=await(await conn.execute('SELECT * FROM watch_groups WHERE owner_id=%s AND deleted_at IS NULL ORDER BY sort,id LIMIT 501',(who.id,))).fetchall()
        user=await(await conn.execute("SELECT coalesce(p.display_name,'') AS nickname FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=%s",(who.id,))).fetchone()
        fire=await(await conn.execute('SELECT value::text AS value_text FROM fire_planning_settings WHERE owner_id=%s',(who.id,))).fetchone()
        if fire:fire={'value':json.loads(fire['value_text'],parse_float=Decimal)}
        blocked=await self.portable_guards(conn,who)
        if len(records)>5000 or len(groups)>500:blocked.append({'domain':'records','reason':'portable_row_budget_exceeded'})
        data={'records':[{**{k:r.get(k) for k in ('id','name','code','market','account_market','price','cost','qty','group_name','note','updated_at','source','watch_group_id')},'user_id':str(who.id)} for r in records[:5000]],'watchGroups':[{**{k:g.get(k) for k in ('id','name','icon','sort','visible','kind','market','created_at')},'user_id':str(who.id)} for g in groups[:500]],'profile':{'nickname':user['nickname'] or ''},'userSettings':[{'user_id':str(who.id),'fire':encoded(fire['value']).decode()}] if fire else [],'tradeOrders':[],'fundTransactions':[],'activities':[],'celebs':[],'siteSettings':{}}
        declarations=await(await conn.execute('SELECT id,record_id,raw::text AS raw_text FROM personal_order_declarations WHERE owner_id=%s ORDER BY id LIMIT 20001',(who.id,))).fetchall()
        if len(declarations)>20000:blocked.append({'domain':'tradeOrders','reason':'portable_row_budget_exceeded'})
        data['tradeOrders']=[{**json.loads(item['raw_text'],parse_float=Decimal),'id':str(item['id']),'record_id':item['record_id'],'user_id':str(who.id)} for item in declarations[:20000]]
        activity_rows=await(await conn.execute('SELECT id,raw::text AS raw_text FROM personal_legacy_activities WHERE owner_id=%s ORDER BY id LIMIT 50001',(who.id,))).fetchall()
        if len(activity_rows)>50000:blocked.append({'domain':'activities','reason':'portable_row_budget_exceeded'})
        data['activities']=[{**json.loads(row['raw_text'],parse_float=Decimal),'id':str(row['id']),'user_id':str(who.id)} for row in activity_rows[:50000]]
        if who.role=='admin':
            site=await(await conn.execute('SELECT settings,allow_register FROM site_settings WHERE singleton')).fetchone()
            data['siteSettings']={**{key:json.dumps(value,ensure_ascii=False) if isinstance(value,(dict,list,bool)) else value for key,value in (site['settings'] if site else {}).items()},'allowRegister':'true' if site and site['allow_register'] else 'false'}
            people=await(await conn.execute('SELECT h.id,h.created_at,r.payload::text AS payload_text,r.created_at AS updated_at FROM celeb_heads h JOIN celeb_revisions r ON r.celeb_id=h.id AND r.revision=h.revision WHERE h.deleted_at IS NULL ORDER BY h.id LIMIT 501')).fetchall()
            if len(people)>500:blocked.append({'domain':'celebs','reason':'portable_row_budget_exceeded'})
            for person in people[:500]:
                value=json.loads(person['payload_text'],parse_float=Decimal)
                data['celebs'].append({'id':person['id'],'name':value['name'],'title':value.get('title',''),'avatar':value.get('avatar',''),'enabled':int(value.get('enabled',False)),'sort':value.get('sort',0),'source_kind':value.get('sourceKind','none'),'cik':value.get('cik',''),'entity':value.get('entity',''),'source_label':value.get('sourceLabel',''),'holdings_json':encoded(value.get('holdings',[])).decode(),'trades_json':encoded(value.get('trades',[])).decode(),'returns_json':encoded(value.get('returns',{})).decode(),'stock_icons_json':encoded(value.get('stockIcons',{})).decode(),'refresh_hours':value.get('refreshHours',0),'created_at':person['created_at'],'updated_at':person['updated_at']})
        # Domain data that cannot be represented is explicit; never call a partial file complete.
        return json.loads(encoded({'format':'fire-site-backup','version':2,'exportedAt':datetime.now(UTC),'data':data,'manifest':{'counts':{k:len(v) for k,v in data.items() if isinstance(v,list)},'portable':not blocked,'blocked':blocked,'scope':'current_owner_only','excluded':['credentials','media_bytes','whole_database','public_catalogues']}}))

    async def export(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            return await self.export_on_connection(conn,who)

    async def preview(self,who,raw):
        if not isinstance(raw,dict) or set(raw)-{'requestId','payload','payloadText','mappings'}:raise HTTPException(400,'预览参数无效')
        rid=identifier(raw.get('requestId'))
        if 'payloadText' in raw:
            if 'payload' in raw or not isinstance(raw['payloadText'],str):raise HTTPException(422,'原文件输入无效')
            source_bytes=raw['payloadText'].encode()
            if len(source_bytes)>10485760:raise HTTPException(413,'个人备份超过10MiB')
            def pairs(items):
                result={}
                for key,value in items:
                    if key in result:raise ValueError('duplicate key')
                    result[key]=value
                return result
            try:payload=json.loads(source_bytes,parse_float=Decimal,object_pairs_hook=pairs,parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            except (ValueError,UnicodeError,RecursionError):raise HTTPException(422,'原JSON文件无效') from None
            representation='uploaded_utf8_json'
        else:payload=raw.get('payload');source_bytes=encoded(payload);representation='canonical_json'
        data,counts=validate(payload);maps=raw.get('mappings',{})
        if not isinstance(maps,dict) or set(maps)-{'sourceOwnerId','accounts','records','groups','funds','publication','siteSettings','celebs','mode','groupIcons'}:raise HTTPException(422,'映射参数无效')
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            closed=await(await conn.execute('SELECT result FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if closed and closed['result'].get('state')=='closed':return closed['result']
            prior=await(await conn.execute('SELECT * FROM personal_data_transfer_previews WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            fingerprint=digest(raw)
            if prior:
                if prior['request_hash']!=fingerprint:raise HTTPException(409,'原UUID已用于其他备份')
                return closed['result'] if closed else prior['plan']
            if closed:raise HTTPException(409,'已完成请求缺少可核对的原预览')
            if maps.get('mode') not in (None,'legacy-portable','mapped-domain-import'):raise HTTPException(422,'导入模式无效')
            blocked=[] if maps.get('mode')=='mapped-domain-import' else await self.portable_guards(conn,who)
            owners={str(row['user_id']) for key in LIMITS for row in data.get(key,[]) if row.get('user_id') is not None}
            if owners and (len(owners)!=1 or maps.get('sourceOwnerId') not in owners):blocked.append({'domain':'owner','reason':'explicit_source_owner_required'})
            for key in ('accounts','records','groups','funds','celebs','groupIcons'):
                if not isinstance(maps.get(key,{}),dict):raise HTTPException(422,'映射必须为对象')
            if 'publication' in maps and type(maps['publication']) is not bool:raise HTTPException(422,'公开确认必须为布尔值')
            if any(not isinstance(value,str) or not value for key in ('records','groups') for value in maps.get(key,{}).values()):raise HTTPException(422,'目标ID必须为非空文字')
            declarations=[]
            for item in data.get('tradeOrders',[]):
                if item.get('status')=='filled':continue
                if item.get('status') not in ('pending','cancelled','expired'):
                    blocked.append({'domain':'tradeOrders','id':str(item['id']),'reason':'unknown_original_order_state'});continue
                target=maps.get('records',{}).get(str(item.get('record_id')))
                if target:
                    verified=await(await conn.execute('SELECT r.id,r.broker_account_id,b.account_kind FROM portfolio_records r LEFT JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.broker_account_id WHERE r.owner_id=%s AND r.id=%s AND r.deleted_at IS NULL',(who.id,target))).fetchone()
                    if not verified:blocked.append({'domain':'tradeOrders','id':str(item['id']),'reason':'declaration_record_mapping_not_owned'})
                elif str(item.get('record_id')) not in {str(record['id']) for record in data.get('records',[])}:
                    blocked.append({'domain':'tradeOrders','id':str(item['id']),'reason':'declaration_parent_mapping_required'})
                declarations.append({'originalId':str(item['id']),'originalStatus':item['status'],'executionEnabled':False,'brokerExecution':False,'authority':'owner_imported_inactive_declaration'})
            order_plan=None

            if data.get('celebs') or data.get('siteSettings'):
                if who.role!='admin':blocked.append({'domain':'administration','reason':'current_administrator_required'})
                elif maps.get('publication') is not True:blocked.append({'domain':'administration','reason':'explicit_publication_confirmation_required'})
            for row in data.get('userSettings',[]):
                try:fire=json.loads(row.get('fire','{}'),parse_float=Decimal)
                except (ValueError,TypeError):raise HTTPException(422,'userSettings.fire不是有效JSON') from None
                if not isinstance(fire,dict):raise HTTPException(422,'fire必须为对象')
                if any(k not in {'currency','baseCurrency','displayCurrency','fireTargetUsd','fireTargetBase','currentInput','passiveInput','originalInput','yearsInput','annualExpense','withdrawalRate','annualReturn','inflation','savingsRate','tableRows','assetHistory'} for k in fire):blocked.append({'domain':'userSettings','reason':'F37_or_unknown_field_handler_required'})
            administration={'celebs':[],'sitePatch':None}
            if who.role=='admin' and maps.get('publication') is True:
                from .celeb_core import normalized
                for item in data.get('celebs',[]):
                    try:
                        target=maps.get('celebs',{}).get(str(item['id']))
                        if not isinstance(target,dict):raise HTTPException(422,'请逐人物明确目标ID与登记素材')
                        value={'id':target.get('id'),'name':item.get('name'),'title':item.get('title') or '', 'avatar':target.get('avatar',''),'enabled':bool(item.get('enabled')),'sort':int(item.get('sort',0)), 'sourceKind':item.get('source_kind') or 'none','cik':item.get('cik') or '', 'entity':item.get('entity') or '', 'sourceLabel':item.get('source_label') or '', 'holdings':json.loads(item.get('holdings_json') or '[]',parse_float=Decimal),'trades':json.loads(item.get('trades_json') or '[]',parse_float=Decimal),'returns':json.loads(item.get('returns_json') or '{}',parse_float=Decimal),'stockIcons':target.get('stockIcons',{}),'refreshHours':item.get('refresh_hours',0)}
                        administration['celebs'].append(json.loads(encoded(await normalized(conn,value))))
                    except (HTTPException,ValueError,TypeError) as exc:blocked.append({'domain':'celebs','id':str(item['id']),'reason':'public_disclosure_mapping_required','detail':str(exc.detail) if isinstance(exc,HTTPException) else 'invalid source JSON'})
                if data.get('siteSettings'):
                    from .site_settings import normalize as normalize_site
                    patch=maps.get('siteSettings')
                    try:
                        if not isinstance(patch,dict) or set(patch)!=set(data['siteSettings']):raise HTTPException(422,'每个原站点字段须明确规范化且不丢弃')
                        administration['sitePatch']=normalize_site(patch)
                    except HTTPException as exc:blocked.append({'domain':'siteSettings','reason':'dedicated_authority_mapping_required','detail':exc.detail})
            accounts=await(await conn.execute('SELECT id,account_kind FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL',(who.id,))).fetchall();known={a['id']:a for a in accounts}
            for row in data.get('records',[]):
                mapping=maps.get('accounts',{}).get(str(row['id']))
                if mapping:
                    target=known.get(mapping.get('accountId')) if isinstance(mapping,dict) else None
                    if not target or target['account_kind'] not in ('real','simulated') or target['account_kind']!=mapping.get('accountKind'):blocked.append({'domain':'records','id':str(row['id']),'reason':'verified_owner_account_kind_mapping_required'})
                elif row.get('qty') not in (None,'',0,'0'):blocked.append({'domain':'records','id':str(row['id']),'reason':'account_mapping_required_for_nonzero_position'})
            for group in data.get('watchGroups',[]):
                if group.get('kind','custom')!='custom' and not maps.get('groups',{}).get(str(group['id'])):blocked.append({'domain':'watchGroups','id':str(group['id']),'reason':'explicit_current_market_group_mapping_required'})
                if group.get('icon') and str(group['id']) not in maps.get('groupIcons',{}):blocked.append({'domain':'watchGroups','id':str(group['id']),'reason':'registered_icon_mapping_or_explicit_clear_required'})
                if str(group['id']) in maps.get('groupIcons',{}) and not isinstance(maps['groupIcons'][str(group['id'])],str):raise HTTPException(422,'图标映射必须为已登记地址或空文字')
            current_fire=await(await conn.execute('SELECT value::text AS value_text FROM fire_planning_settings WHERE owner_id=%s',(who.id,))).fetchone()
            for row in data.get('userSettings',[]):
                incoming_fire=json.loads(row.get('fire','{}'),parse_float=Decimal)
                from .fire_transfer import plan_transfer
                try:plan_transfer(json.loads(current_fire['value_text'],parse_float=Decimal) if current_fire else {},incoming_fire,datetime.now(ZoneInfo('Asia/Shanghai')).year)
                except HTTPException as exc:blocked.append({'domain':'userSettings','reason':'historical_observation_conflict','detail':exc.detail})
            source,pid=uuid4(),uuid4();now=datetime.now(UTC)
            await conn.execute('INSERT INTO personal_data_transfer_sources(owner_id,id,request_id,origin_instance,sha256,raw) VALUES(%s,%s,%s,%s,%s,%s)',(who.id,source,rid,self.db.settings.instance_id,hashlib.sha256(source_bytes).hexdigest(),source_bytes))
            fund_previews=[]
            from .fund_sources import FundSources
            try:
                async with conn.transaction(force_rollback=True):
                    _groups,staged_records,_children=await self.apply_records(conn,who,data,maps,rid)
                    staged_maps={**maps,'records':{**maps.get('records',{}),**staged_records}}
                    if any(item.get('status')=='filled' for item in data.get('tradeOrders',[])):
                        order_plan=await self.prepare_orders(conn,who,data,staged_maps,source_bytes,rid,store=False)
                        blocked.extend({'domain':'tradeOrders','id':str(item['rowIndex']),'reason':item.get('reason','execution_state_not_portable')} for item in order_plan['rows'] if item['state'] not in ('ready','duplicate'))
                    if order_plan and all(item['state'] in ('ready','duplicate') for item in order_plan['rows']):
                        from .legacy_order_import import OrderImport
                        staged=await self.prepare_orders(conn,who,data,staged_maps,source_bytes,rid,store=True)
                        outcome=await OrderImport(TransactionDB(self.db,conn)).submit(who,{'requestId':str(uuid5(UUID(rid),'orders')),'previewId':staged['previewId'],'confirm':True})
                        if outcome.get('partial'):blocked.append({'domain':'tradeOrders','reason':'cross_domain_historical_execution_failed'})
                    for item in data.get('fundTransactions',[]):
                        old=str(item['id']);mapping=maps.get('funds',{}).get(old,{})
                        target=known.get(mapping.get('accountId')) if isinstance(mapping,dict) else None
                        if not target or target['account_kind']!=mapping.get('accountKind') or item.get('type') not in ('opening','deposit','withdrawal','adjustment'):
                            blocked.append({'domain':'fundTransactions','id':old,'reason':'explicit_cash_scope_or_adjustment_evidence_required'});continue
                        action={'opening':'opening','deposit':'external_deposit','withdrawal':'external_withdrawal','adjustment':'reconcile_balance'}[item['type']]
                        if item.get('direction') not in ((-1,'-1',1,'1') if item['type']=='adjustment' else (-1,'-1') if item['type']=='withdrawal' else (1,'1')):
                            blocked.append({'domain':'fundTransactions','id':old,'reason':'cash_direction_type_mismatch'});continue
                        command={'requestId':str(uuid5(UUID(rid),'fund:'+old)),'kind':'create','sourceType':item['type'],'cash':{'accountId':target['id'],'accountKind':target['account_kind'],'currency':item.get('currency'),'action':action,'amount':str(item.get('amount')),'occurredAt':item.get('occurred_at'),'note':item.get('note') or ''}}
                        if item['type']=='adjustment':
                            if mapping.get('targetBalance') is None or not isinstance(mapping.get('evidence'),dict):
                                blocked.append({'domain':'fundTransactions','id':old,'reason':'actual_target_balance_and_observation_required'});continue
                            command['cash']['amount']=str(mapping['targetBalance']);command['cash']['evidence']=mapping['evidence']
                        if mapping.get('openingBasis') is not None:command['cash']['openingBasis']=mapping['openingBasis']
                        try:
                            prepared=await FundSources(TransactionDB(self.db,conn)).preview(who,command,connection=conn)
                            if item['type']=='adjustment' and Decimal(prepared['delta'])!=Decimal(str(item['amount']))*Decimal(str(item['direction'])):raise HTTPException(409,'原调整差额与明确实际余额不一致')
                            fund_previews.append({'command':command,'viewBasis':'sequential_rollback_only_authority_plan','view':fund_semantics(prepared)})
                            await FundSources(TransactionDB(self.db,conn)).submit(who,{'command':command,'previewId':prepared['previewId'],'cashPreview':prepared['cashPreview'],'confirm':True},connection=conn)
                        except HTTPException as exc:
                            if exc.status_code>=500:raise
                            blocked.append({'domain':'fundTransactions','id':old,'reason':'cash_authority_rejected','detail':exc.detail})
            except HTTPException as exc:
                if exc.status_code in (401,403) or exc.status_code>=500:raise
                blocked.append({'domain':'coordinator','reason':'domain_preview_rejected','detail':exc.detail})
            plan={'requestId':rid,'previewId':str(pid),'sourceId':str(source),'representation':representation,'expiresAt':datetime.fromtimestamp(now.timestamp()+900,UTC).isoformat(),'counts':counts,'administration':administration,'orderDeclarations':declarations,'executionOrder':['filled_trades','fund_sources'],'orderPlan':order_plan,'fundPreviews':fund_previews,'blocked':blocked,'confirmSupported':not blocked,'mappings':maps,'domainRevisions':await self.revisions(conn,who),'state':'previewed'}
            plan=json.loads(encoded(plan))
            await conn.execute('INSERT INTO personal_data_transfer_previews(owner_id,id,source_id,request_id,request_hash,authorization_binding,plan) VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,pid,source,rid,fingerprint,self.binding(who),Jsonb(plan)))
            return plan

    async def receipt(self,who,rid):
        rid=identifier(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT result FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if row:return row['result']
            preview=await(await conn.execute('SELECT plan FROM personal_data_transfer_previews WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if preview:return preview['plan']
            raise HTTPException(404,'原个人导入UUID尚无回执')

    async def close(self,who,rid):
        rid=identifier(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            prior=await(await conn.execute('SELECT result FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:return prior['result']
            result={'requestId':rid,'state':'closed','executed':False}
            await conn.execute('INSERT INTO personal_data_transfer_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)',(who.id,rid,'closed',Jsonb(result)))
            return result

    async def original(self,who,source_id):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT raw,sha256,origin_instance FROM personal_data_transfer_sources WHERE owner_id=%s AND id=%s',(who.id,UUID(str(source_id))))).fetchone()
            if not row:raise HTTPException(404,'本人原件不存在')
            return {'raw':bytes(row['raw']),'sha256':row['sha256'],'mediaType':'application/json'}

    async def before_image(self,who,rid):
        rid=identifier(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT raw,sha256 FROM personal_data_transfer_before_images WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if not row:raise HTTPException(404,'本人导入前态不存在')
            return {'raw':bytes(row['raw']),'sha256':row['sha256'],'mediaType':'application/json'}

    async def submit(self,who,raw):
        if not isinstance(raw,dict) or not {'requestId','previewId'}<=set(raw) or set(raw)-{'requestId','previewId','password','code'}:raise HTTPException(400,'请确认原预览与操作编号')
        rid=identifier(raw['requestId']);pid=identifier(raw['previewId']);fingerprint=digest({key:value for key,value in raw.items() if key not in ('password','code')})
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            prior=await(await conn.execute('SELECT * FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['request_hash'] not in ('closed',fingerprint):raise HTTPException(409,'原UUID内容不一致')
                return prior['result']
            row=await(await conn.execute('SELECT p.*,s.raw,s.origin_instance FROM personal_data_transfer_previews p JOIN personal_data_transfer_sources s ON s.owner_id=p.owner_id AND s.id=p.source_id WHERE p.owner_id=%s AND p.id=%s FOR UPDATE OF p',(who.id,pid))).fetchone()
            if not row or row['authorization_binding']!=self.binding(who) or str(row['origin_instance'])!=str(self.db.settings.instance_id):raise HTTPException(409,'原预览或会话不一致')
            if row['expires_at']<=datetime.now(UTC):raise HTTPException(409,'预览已过期')
            if str(row['request_id'])!=rid:raise HTTPException(409,'请沿用原预览UUID')
            plan=row['plan']
            if plan['blocked']:raise HTTPException(409,{'state':'blocked','blocked':plan['blocked']})
            if await self.revisions(conn,who)!=plan['domainRevisions']:raise HTTPException(409,'本人数据已变化，请重新预览')
            payload=json.loads(bytes(row['raw']),parse_float=Decimal);data,_counts=validate(payload)
            before=encoded(await self.export_on_connection(conn,who))
            if len(before)>10485760:raise HTTPException(413,'本人前态快照超过安全预算，未执行导入')
            await conn.execute('INSERT INTO personal_data_transfer_before_images(owner_id,request_id,sha256,raw) VALUES(%s,%s,%s,%s)',(who.id,rid,hashlib.sha256(before).hexdigest(),before))
            maps=plan['mappings'];bound=TransactionDB(self.db,conn)
            from .profile_update import ProfileUpdate
            group_map,record_map,children=await self.apply_records(conn,who,data,maps,rid)
            def child(label):return str(uuid5(UUID(rid),label))
            for item in data.get('tradeOrders',[]):
                if item.get('status') not in ('pending','cancelled','expired'):continue
                record_id=record_map.get(str(item.get('record_id'))) or maps.get('records',{}).get(str(item.get('record_id')))
                parent=await(await conn.execute('SELECT r.id,r.broker_account_id,b.account_kind FROM portfolio_records r LEFT JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.broker_account_id WHERE r.owner_id=%s AND r.id=%s AND r.deleted_at IS NULL',(who.id,record_id))).fetchone()
                if not parent:raise HTTPException(409,'原意图声明引用的本人记录已变化')
                inserted=await conn.execute('INSERT INTO personal_order_declarations(owner_id,id,source_id,original_id,original_status,record_id,account_id,account_kind,raw,content_hash) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,content_hash) DO NOTHING',(who.id,UUID(child('intent-declaration:'+str(item['id']))),row['source_id'],str(item['id']),item['status'],parent['id'],parent['broker_account_id'],parent['account_kind'],Jsonb(json.loads(encoded(item))),digest(item)))
                if inserted.rowcount:
                    await conn.execute('INSERT INTO internal_order_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING',(who.id,))
                    await conn.execute('UPDATE internal_order_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            for item in data.get('activities',[]):
                content=digest(item)
                await conn.execute('INSERT INTO personal_legacy_activities(owner_id,id,source_id,original_id,raw,content_hash) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,content_hash) DO NOTHING',(who.id,UUID(child('activity:'+str(item['id']))),row['source_id'],str(item['id']),Jsonb(json.loads(encoded(item))),content))
            if any(item.get('status')=='filled' for item in data.get('tradeOrders',[])):
                from .legacy_order_import import OrderImport
                prepared_orders=await self.prepare_orders(conn,who,data,{**maps,'records':{**maps.get('records',{}),**record_map}},bytes(row['raw']),rid,store=True)
                if any(item['state'] not in ('ready','duplicate') for item in prepared_orders['plan']['rows']):raise HTTPException(409,'订单核对发生变化')
                outcome=await OrderImport(bound).submit(who,{'requestId':child('orders'),'previewId':prepared_orders['previewId'],'confirm':True})
                if outcome.get('partial'):raise HTTPException(409,'订单组未全部通过，个人导入整批回滚')
                children.append(outcome)
            from .fund_sources import FundSources
            for fund in plan.get('fundPreviews',[]):
                fresh=await FundSources(bound).preview(who,fund['command'],connection=conn)
                if fund_semantics(fresh)!=fund['view']:raise HTTPException(409,'累计现金投影与原预览不一致，整批未执行')
                children.append(await FundSources(bound).submit(who,{'command':fund['command'],'previewId':fresh['previewId'],'cashPreview':fresh['cashPreview'],'confirm':True},connection=conn))
            nickname=data.get('profile',{}).get('nickname')
            from .identity_mail import IdentityMail
            mail=IdentityMail(self.db.settings,bound,dynamic=True)
            if nickname is not None:children.append(await ProfileUpdate(self.db.settings,bound,mail).save(who,{'nickname':nickname},UUID(child('profile'))))
            for item in data.get('userSettings',[]):
                from .fire_planning import FirePlanning
                fire=json.loads(item.get('fire','{}'),parse_float=Decimal)
                current=await(await conn.execute('SELECT revision FROM fire_planning_settings WHERE owner_id=%s',(who.id,))).fetchone()
                children.append(await FirePlanning(bound).import_history_on_connection(conn,who,child('fire'),current['revision'] if current else 0,fire))
            administration=plan.get('administration',{})
            if administration.get('sitePatch'):
                from .notification_security import NotificationSecurity
                from .site_settings import SiteSettings
                current=await(await conn.execute('SELECT revision FROM site_settings WHERE singleton')).fetchone()
                children.append(await SiteSettings(bound,mail).save(who,UUID(child('site-settings')),current['revision'],administration['sitePatch'],raw.get('password'),raw.get('code',''),NotificationSecurity(bound).passkeys))
            if administration.get('celebs'):
                from .celeb_core import Celebs
                for value in administration['celebs']:
                    scope=await(await conn.execute('SELECT revision FROM celeb_scope WHERE singleton')).fetchone()
                    current=await(await conn.execute('SELECT 1 FROM celeb_heads WHERE id=%s',(value['id'],))).fetchone()
                    children.append(await Celebs(bound).mutate(who,child('celeb:'+value['id']),'update' if current else 'create',value,scope['revision']))
            result={'requestId':rid,'previewId':pid,'state':'completed','executed':True,'counts':plan['counts'],'idMappings':{'groups':group_map,'records':record_map},'children':children,'beforeImageSha256':hashlib.sha256(before).hexdigest(),'sourceId':str(row['source_id'])}
            result=json.loads(encoded(result))
            await conn.execute('INSERT INTO personal_data_transfer_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)',(who.id,rid,fingerprint,Jsonb(result)))
            return result

    async def prepare_orders(self,conn,who,data,maps,raw,rid,*,store):
        from .legacy_flat_orders import snapshot
        from .legacy_order_import import OrderImport
        from .notification_security import principal
        from .personal_order_projection import personal_order_rows
        source_rows=personal_order_rows(data);mapping={}
        for index,item in enumerate([row for row in data.get('tradeOrders',[]) if row.get('status')=='filled'],1):
            target=maps.get('records',{}).get(str(item.get('record_id')))
            mapping[str(index)]={'recordId':target or ''}
        bound=TransactionDB(self.db,conn);service=OrderImport(bound);view=await snapshot(conn,who,exact=True)
        plan=await service.plan(conn,who,source_rows,mapping,view)
        for item in plan['rows']:
            if item['state']=='ignored':item.update(state='blocked',reason='pending_cancelled_or_dividend_requires_separate_authority')
        if not store:return service.public(plan)
        source_hash=hashlib.sha256(raw).hexdigest()
        parent=await(await conn.execute('SELECT id,raw,origin_instance,sha256 FROM personal_data_transfer_sources WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
        if (not parent or str(parent['origin_instance'])!=str(self.db.settings.instance_id)
                or parent['sha256']!=source_hash or bytes(parent['raw'])!=raw):
            raise HTTPException(409,'个人订单子预览缺少同实例、同本人、同原文父来源')
        plan['personalTransfer']={'ownerId':who.id,'instanceId':str(self.db.settings.instance_id),
            'parentRequestId':rid,'parentSourceId':str(parent['id']),
            'childRequestId':str(uuid5(UUID(rid),'orders')),'sourceSha256':source_hash}
        source,pid=uuid4(),uuid4()
        await conn.execute('INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,source,'personal-data-transfer.json',hashlib.sha256(raw).hexdigest(),raw,Jsonb(source_rows),principal(who),self.db.settings.instance_id))
        await conn.execute('INSERT INTO legacy_order_import_previews(owner_id,id,source_id,snapshot_revision,mappings,result,principal) VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,pid,source,view['snapshotRevision'],Jsonb(mapping),Jsonb(plan),principal(who)))
        return {'previewId':str(pid),'plan':plan}

    async def apply_records(self,conn,who,data,maps,rid):
        bound=TransactionDB(self.db,conn)
        from .watchlists import WatchGroups
        groups=WatchGroups(bound);group_map=dict(maps.get('groups',{}));record_map={};children=[]
        def child(label):return str(uuid5(UUID(rid),label))
        group_rows=[]
        for item in data.get('watchGroups',[]):
            old=str(item['id']);target=group_map.get(old)
            if not target and item.get('kind','custom')=='custom':
                from .watchlists import name_value
                _name,key=name_value(item.get('name'))
                same=await(await conn.execute("SELECT id FROM watch_groups WHERE owner_id=%s AND kind='custom' AND name_key=%s AND deleted_at IS NULL",(who.id,key))).fetchone()
                target=same['id'] if same else 'wg-'+uuid5(NAMESPACE_URL,str(who.id)+':'+str(maps.get('sourceOwnerId'))+':'+old).hex
            if not target:raise HTTPException(409,'请明确市场分组映射')
            group_map[old]=target
            visible=item.get('visible',-1)
            if visible not in (-1,0,1):raise HTTPException(422,'原分组可见状态无效')
            group_rows.append({'originalId':old,'targetId':target,'name':item.get('name'),'kind':item.get('kind','custom'),'market':item.get('market') or '', 'sort':int(item.get('sort',0)),'visible':visible})
        if group_rows:
            children.append(await groups.mutate(who.id,'source-import',{'groups':group_rows,'members':[]},child('groups'),authorization=who))
            for original_id,icon in maps.get('groupIcons',{}).items():
                if original_id not in group_map:raise HTTPException(422,'图标映射不在原分组内')
                children.append(await groups.mutate(who.id,'update',{'id':group_map[original_id],'icon':icon},child('group-icon:'+original_id),authorization=who))
        service=PortfolioRecords(bound)
        for item in data.get('records',[]):
            old=str(item['id']);target=maps.get('records',{}).get(old);existing=None
            if target:
                existing=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL',(who.id,target))).fetchone()
                if not existing:raise HTTPException(409,'记录映射不属于本人')
            group=item.get('watch_group_id') or '';mapped_group=group_map.get(group,group)
            account=maps.get('accounts',{}).get(old,{})
            patch={'name':item.get('name'),'code':item.get('code'),'market':item.get('market'),'accountMarket':item.get('account_market') or '',**{k:item.get(k) for k in ('price','cost','qty')},'group':item.get('group_name') or '', 'note':item.get('note') or '', 'source':item.get('source') or '', 'watchGroupId':mapped_group,'brokerAccountId':account.get('accountId','')}
            prepared=await service.preview(who.id,'update' if existing else 'create',patch,record_id=target or '',revision=existing['revision'] if existing else None,authorization=who,source_create_id=None if existing else 'r-'+uuid5(UUID(rid),'record-id:'+old).hex)
            out=await service.confirm(who.id,UUID(prepared['previewId']),UUID(child('record:'+old)),authorization=who);record_map[old]=out['recordId'];children.append(out)
        return group_map,record_map,children


async def legacy_activities_on_connection(conn,owner,*,limit=200,offset=0):
    present=await(await conn.execute("SELECT to_regclass('public.personal_legacy_activities') AS relation,EXISTS(SELECT 1 FROM schema_migrations WHERE name='0134_personal_data_transfer.sql') AS installed")).fetchone()
    if not present['relation']:
        if present['installed']:raise HTTPException(503,'个人活动声明结构不完整')
        return {'items':[],'hasMore':False,'nextOffset':None,'state':'not_installed'}
    if not present['installed']:raise HTTPException(503,'个人活动声明结构未完整登记')
    if type(limit) is not int or not 1<=limit<=200 or type(offset) is not int or offset<0:raise HTTPException(400,'活动分页无效')
    rows=await(await conn.execute('SELECT id,source_id,original_id,raw,created_at FROM personal_legacy_activities WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s',(owner,limit+1,offset))).fetchall()
    return {'items':[{'id':str(row['id']),'sourceId':str(row['source_id']),'originalId':row['original_id'],'source':'personal_import_declaration','platformAudit':False,'original':row['raw']} for row in rows[:limit]],'hasMore':len(rows)>limit,'nextOffset':offset+limit if len(rows)>limit else None}


async def order_declarations_on_connection(conn,owner,*,limit=50,offset=0):
    present=await(await conn.execute("SELECT to_regclass('public.personal_order_declarations') AS relation,EXISTS(SELECT 1 FROM schema_migrations WHERE name='0134_personal_data_transfer.sql') AS installed" )).fetchone()
    if not present['relation']:
        if present['installed']:raise HTTPException(503,'个人意图声明结构不完整')
        return {'items':[],'total':0,'nextOffset':None,'state':'not_installed'}
    if not present['installed']:raise HTTPException(503,'个人意图声明结构未完整登记')
    rows=await(await conn.execute('SELECT id,source_id,original_id,original_status,record_id,account_id,account_kind,raw FROM personal_order_declarations WHERE owner_id=%s ORDER BY created_at,id LIMIT %s OFFSET %s',(owner,limit,offset))).fetchall()
    total=(await(await conn.execute('SELECT count(*) AS n FROM personal_order_declarations WHERE owner_id=%s',(owner,))).fetchone())['n']
    return {'items':[{'id':str(row['id']),'sourceId':str(row['source_id']),'originalId':row['original_id'],'originalStatus':row['original_status'],'recordId':row['record_id'],'accountId':row['account_id'],'accountKind':row['account_kind'],'original':row['raw'],'status':'imported_declaration','executionEnabled':False,'brokerExecution':False,'reservationEffect':'none','authority':'owner_imported_inactive_declaration'} for row in rows],'total':total,'nextOffset':offset+len(rows) if offset+len(rows)<total else None,'state':'observed'}
