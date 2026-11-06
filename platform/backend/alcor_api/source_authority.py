"""Explicit platform/source/owner consent and one immutable source manifest.

No public method accepts a DSN, path, complete flag, authority class or raw source.
The operator registry is passed by the application's controlled configuration.
"""
from .source_read_access import source_read_lock
from .source_window import access_error_message


import asyncio
import json
from pathlib import Path
from uuid import UUID,uuid4

from alcor_api.cash_ledger import CashLedger
from alcor_api.fee_source_inventory import fingerprint as fee_fingerprint
from alcor_api.fee_source_inventory import normalized_snapshot
from alcor_api.financial_import import FinancialImport
from alcor_api.financial_source import parse_source
from alcor_api.security import lock_mutation_identity
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .source_budget import public_status as export_budget_status
from .source_budget import reserve as reserve_export
from .source_mapping import Mapping
from .source_snapshot import TABLES, PgSnapshot, SourceMismatch, canonical, sha


def definition_hash(definition):
    from psycopg.conninfo import conninfo_to_dict
    endpoint={}
    if definition.kind=='postgres':
        endpoint={k:v for k,v in conninfo_to_dict(definition.locator).items() if k in ('host','hostaddr','port','dbname','user','sslmode')}
    else:raise SourceMismatch('source_backend_not_supported')
    return sha(canonical({**definition.public_binding(),'allowedOwners':definition.owners,'endpoint':endpoint,'expectedDatabase':definition.expected_database,'expectedRole':definition.expected_role,'expectedDatasetIdentity':definition.expected_dataset_identity,'dataDirectory':str(definition.expected_data_directory) if definition.expected_data_directory else None}))


def physical_identity_hash(definition):
    from psycopg.conninfo import conninfo_to_dict
    if definition.kind=='postgres':
        if definition.expected_dataset_identity:return sha(canonical(definition.expected_dataset_identity))
        endpoint={k:v for k,v in conninfo_to_dict(definition.locator).items() if k in ('host','hostaddr','port')}
        value={'kind':'postgres','endpoint':endpoint,'database':definition.expected_database,'dataDirectory':str(definition.expected_data_directory)}
    else:raise SourceMismatch('source_backend_not_supported')
    # Aliases, logical labels, credentials and reader-role rotation cannot mint
    # another asset owner for the same explicitly registered physical source.
    return sha(canonical(value))


def uuid(value):
    try:return str(UUID(str(value)))
    except (ValueError,TypeError):raise HTTPException(422,'请求UUID无效') from None


async def verified_inventory_head(conn,head):
    if not head:return None
    row=await(await conn.execute("SELECT m.manifest_sha256,g.state,g.revision,m.grant_revision,(m.manifest->'coverage'->>'complete')::boolean coverage_complete FROM legacy_source_heads h JOIN legacy_source_view_bindings b ON b.owner_id=h.owner_id AND b.manifest_id=h.manifest_id AND b.view_kind='fees' AND b.view_sha256=%s JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id JOIN legacy_source_grants g ON g.id=m.grant_id AND g.owner_id=m.owner_id WHERE h.owner_id=%s AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton)",(head['source_digest'],head['owner_id']))).fetchone()
    verified=bool(row and row['state']=='active' and row['revision']==row['grant_revision'] and row['coverage_complete'])
    return {**head,'sourceDeclaredComplete':head['complete'],'complete':bool(head['complete'] and verified),'sourceVerified':verified,'sourceManifestDigest':row['manifest_sha256'] if row else None}


class SourceAuthority:
    def __init__(self,db,registry,passkeys):
        self.db=db;self.registry=registry;self.passkeys=passkeys;self.cash=CashLedger(db)
        self.after_read=None

    def definition(self, grant):
        definition=self.registry.get(grant['source_alias'])
        if definition:
            try:
                definition.require_access(grant["source_owner"])
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
        if not definition or definition.instance!=grant['source_instance'] or grant['source_owner'] not in definition.owners or definition_hash(definition)!=grant['binding_hash']:
            raise HTTPException(409,'登记的来源实例、路径或结构已变化，请重新授权')
        return definition

    async def register(self, who, data):
        if set(data)!={'requestId','sourceAlias','sourceOwner','targetUserId'}:raise HTTPException(422,'来源授权字段无效')
        request=uuid(data['requestId'])
        payload = {**data, "requestId": request}
        hashed = sha(canonical(payload))
        async with self.db.connection() as conn, conn.transaction():
            await self.cash.lock(conn,who)
            actor=await(await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
            if not actor or actor['role']!='admin':raise HTTPException(403,'需要管理员权限')
            await lock_mutation_identity(conn,who,require_admin=True)
            definition=self.registry.get(data['sourceAlias'])
            if not definition or data['sourceOwner'] not in definition.owners:raise HTTPException(403,'来源实例或原owner未登记')
            prior=await self.prior(conn,who,request,hashed)
            if prior:return prior
            try:
                definition.require_access(data["sourceOwner"])
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
            user=await(await conn.execute('SELECT id,uid FROM users WHERE id=%s AND active FOR SHARE',(data['targetUserId'],))).fetchone()
            if not user:raise HTTPException(404,'目标平台内部账号标识不存在或已停用')
            await self.check_claim(conn,definition.instance,data['sourceOwner'],data['targetUserId'],physical_identity_hash(definition))
            active=await(await conn.execute("SELECT 1 FROM legacy_source_grants WHERE owner_id=%s AND state='active'",(data['targetUserId'],))).fetchone()
            if active:raise HTTPException(409,'该平台账号已有权威来源，请先核对和撤销原授权，不能双源相加')
            identifier=uuid4()
            await conn.execute("INSERT INTO legacy_source_grants(id,owner_id,platform_instance,source_alias,source_instance,source_owner,binding_hash,physical_identity_hash,state,registered_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'pending_owner',%s)",(identifier,data['targetUserId'],self.db.settings.instance_id,definition.alias,definition.instance,data['sourceOwner'],definition_hash(definition),physical_identity_hash(definition),who.id))
            result={'requestId':request,'state':'completed','grantId':str(identifier),'grantRevision':1,'targetUserId':data['targetUserId'],'targetPublicUid':user['uid'],'sourceOwner':data['sourceOwner'],'sourceInstance':definition.instance,'sourceAlias':definition.alias,'permissionState':'pending_owner','financialApplied':False}
            await self.operation(conn,who,request,hashed,result)
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'legacy-source.registered',%s,%s)",(who.id,str(identifier),request))
            return result

    async def consent(self,who,grant_id,data):
        if set(data)!={'requestId','revision','password','code','approve'} or type(data['revision']) is not int or type(data['approve']) is not bool:raise HTTPException(422,'来源确认字段无效')
        request=uuid(data['requestId']);hashed=sha(canonical({'grantId':str(grant_id),'revision':data['revision'],'approve':data['approve']}))
        from alcor_api.main import rate_limit
        from alcor_api.security import digest
        if not await rate_limit(self.db,digest('identity-manage:'+who.id),20):raise HTTPException(429,'操作过于频繁，请稍后再试')
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            prior=await self.prior(conn,who,request,hashed)
            if prior:return prior
            await self.passkeys.step_up(conn,who,data['password'],data['code'])
            grant=await(await conn.execute('SELECT * FROM legacy_source_grants WHERE id=%s AND owner_id=%s FOR UPDATE',(grant_id,who.id))).fetchone()
            if not grant:raise HTTPException(404,'本人来源授权不存在')
            if data['approve']:self.definition(grant)
            if grant['revision']!=data['revision'] or grant['state']=='revoked':raise HTTPException(409,'来源授权版本已变化')
            state='active' if data['approve'] else 'revoked'
            if state=='active' and grant['state']!='pending_owner':raise HTTPException(409,'该来源已经确认')
            if state=='active':await self.check_claim(conn,grant['source_instance'],grant['source_owner'],who.id,grant['physical_identity_hash'])
            if state=='active' and await(await conn.execute("SELECT 1 FROM legacy_source_grants WHERE state='active' AND source_owner=%s AND (source_instance=%s OR physical_identity_hash=%s) AND id<>%s",(grant['source_owner'],grant['source_instance'],grant['physical_identity_hash'],grant_id))).fetchone():raise HTTPException(409,'此原来源已有有效授权，不能重复分配原账')
            if state=='active' and await(await conn.execute("SELECT 1 FROM legacy_source_grants WHERE owner_id=%s AND state='active'",(who.id,))).fetchone():raise HTTPException(409,'本人已有另一权威来源')
            await conn.execute("UPDATE legacy_source_grants SET state=%s,revision=revision+1,approved_at=CASE WHEN %s='active' THEN clock_timestamp() ELSE approved_at END,revoked_at=CASE WHEN %s='revoked' THEN clock_timestamp() ELSE NULL END WHERE id=%s",(state,state,state,grant_id))
            result={'requestId':request,'state':'completed','grantId':str(grant_id),'grantRevision':grant['revision']+1,'permissionState':state,'financialApplied':False}
            await self.operation(conn,who,request,hashed,result)
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'legacy-source.consent',%s,%s)",(who.id,str(grant_id),request))
            return result

    async def grant(self,conn,who,grant_id,revision):
        row=await(await conn.execute("SELECT * FROM legacy_source_grants WHERE id=%s AND owner_id=%s AND state='active' FOR SHARE",(grant_id,who.id))).fetchone()
        if not row or row['revision']!=revision or row['platform_instance']!=self.db.settings.instance_id:raise HTTPException(409,'来源授权未生效、已撤销或版本已变化')
        self.definition(row)
        await self.check_claim(conn,row['source_instance'],row['source_owner'],who.id,row['physical_identity_hash'])
        return row

    async def archive_grant(self,conn,who,grant_id,revision,*,manifest_id,archive_kind='financial'):
        from .source_archive import archive_grant
        return await archive_grant(self,conn,who,grant_id,revision,manifest_id=manifest_id,archive_kind=archive_kind)

    async def check_claim(self,conn,source_instance,source_owner,owner,physical_hash):
        rows=await(await conn.execute('SELECT * FROM legacy_source_owner_claims WHERE (source_instance=%s AND source_owner=%s) OR (physical_identity_hash=%s AND source_owner=%s) FOR SHARE',(source_instance,source_owner,physical_hash,source_owner))).fetchall()
        if any(row['owner_id']!=owner or row['source_instance']!=source_instance or row['physical_identity_hash']!=physical_hash for row in rows):
            raise HTTPException(409,'原来源已有不可变账号归属；撤销授权不会转移原账，变更须独立迁移方案')
        return rows

    async def prior(self,conn,who,request,hashed):
        row=await(await conn.execute('SELECT * FROM legacy_source_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
        if row:
            if row['fingerprint']!=hashed:raise HTTPException(409,'原UUID已用于其他来源操作')
            return row['result']

    async def operation(self,conn,who,request,hashed,result):
        await conn.execute('INSERT INTO legacy_source_operations(owner_id,request_id,fingerprint,state,result) VALUES(%s,%s,%s,%s,%s)',(who.id,request,hashed,result['state'],Jsonb(result)))

    def prefix_check(self,bundle,previous):
        if not previous:return
        old=json.loads(bytes(previous['raw']));new=json.loads(bundle['raw']);conflicts=[]
        for table,old_table in old['tables'].items():
            key='order_id' if table.startswith(('app_asset_order','app_trade_metadata','trade_fee_','trade_correction_')) and table not in ('trade_fee_detail_history','trade_correction_operations') else 'record_id' if table=='record_revisions' else 'id'
            if table=='broker_cash_order_links':key='order_id'
            if table in ('broker_cash_accounts',):key=None
            def identity(row):
                if key and key in row:return row[key].get('text')
                return sha(canonical({k:row.get(k) for k in ('user_id','account_id','currency','request_id') if k in row}))
            current={identity(row):row for row in new['tables'][table]['rows']}
            for row in old_table['rows']:
                original=identity(row);now=current.get(original)
                # A live source record/current cash revision is a projection. Its
                # delta must be reconciled against appended fills before importing;
                # it is not silently overwritten or treated as an immutable event.
                if table in ('records','record_revisions','broker_cash_accounts','broker_accounts'):
                    if now is None:conflicts.append({'table':table,'originalId':original,'reason':'source_object_disappeared'})
                    elif table in ('records','broker_accounts'):
                        stable=('code','market','account_market','broker_account_id','source') if table=='records' else ('provider_id','account_kind','holding_source','currency','currencies_json')
                        if any(now.get(column)!=row.get(column) for column in stable):conflicts.append({'table':table,'originalId':original,'reason':'source_identity_changed'})
                elif now!=row:conflicts.append({'table':table,'originalId':original,'reason':'source_prefix_changed_or_deleted'})
        bundle['manifest']['prefixCheck']={'predecessorManifest':previous['manifest_sha256'],'conflicts':conflicts,'appendOnlyPrefixVerified':not conflicts}
        for item in conflicts:bundle['manifest']['normalizationBlockers'].append({'code':'source_prefix_conflict',**item})

    async def export(self,who,grant_id,data):
        if set(data)!={'requestId','grantRevision','predecessorHash'} or type(data['grantRevision']) is not int:raise HTTPException(422,'导出版本或前驱核对字段无效')
        request=uuid(data['requestId']);hashed=sha(canonical({**data,'grantId':str(grant_id)}))
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            prior=await self.prior(conn,who,request,hashed)
            if prior:return prior
            grant=await self.grant(conn,who,grant_id,data['grantRevision']);definition=self.definition(grant)
            head=await(await conn.execute('SELECT * FROM legacy_source_heads WHERE owner_id=%s FOR UPDATE',(who.id,))).fetchone()
            if (head['manifest_sha256'] if head else None)!=data['predecessorHash']:raise HTTPException(409,'来源快照前驱已变化，请查询原清单')
            reservation=await reserve_export(conn,who.id,self.db.settings.instance_id)
            await self.operation(conn,who,request,hashed,{'requestId':request,'state':'reading','operationType':'source_export','platformInstance':str(self.db.settings.instance_id),'reservationBytes':reservation,'financialApplied':False,'retry':'query_original_uuid'})
        try:
            snapshot=await PgSnapshot().export(definition,grant['source_owner'])
            if self.after_read:await self.after_read()
            # Export metadata is separate from original row values/types. It gives
            # a new authorized read its own version even if source content is unchanged.
            snapshot['source'].update(exportOperationId=request,sourceBindingHash=grant['binding_hash'],grantId=str(grant_id),grantRevision=data['grantRevision'])
            bundle=await asyncio.to_thread(lambda:Mapping(snapshot).build())
            if bundle['financial'] is not None:
                try:parse_source(canonical(bundle['financial']))
                except HTTPException:
                    bundle['financial']=None;bundle['manifest']['financialSha256']=None;bundle['manifest']['normalizationBlockers'].append({'code':'financial_view_contract_cannot_represent_original_scope'})
            if bundle['fee'] is not None:
                try:normalized_snapshot(bundle['fee'])
                except (ValueError,TypeError,KeyError):
                    bundle['fee']=None;bundle['manifest']['feeInventorySha256']=None;bundle['manifest']['normalizationBlockers'].append({'code':'fee_view_contract_cannot_represent_original_scope'})
            async with self.db.connection() as conn,conn.transaction():
                await self.cash.lock(conn,who);await self.grant(conn,who,grant_id,data['grantRevision'])
                head=await(await conn.execute('SELECT * FROM legacy_source_heads WHERE owner_id=%s FOR UPDATE',(who.id,))).fetchone()
                if (head['manifest_sha256'] if head else None)!=data['predecessorHash']:raise SourceMismatch('source_predecessor_changed_during_read')
                previous=await(await conn.execute('SELECT * FROM legacy_source_manifests WHERE id=%s',(head['manifest_id'],))).fetchone() if head else None
                self.prefix_check(bundle,previous)
                if snapshot['source']['ownerVerified'] and snapshot['source']['datasetIdentityVerified']:
                    await conn.execute('INSERT INTO legacy_source_owner_claims(source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id,platform_instance) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(grant['source_instance'],grant['source_owner'],who.id,grant['physical_identity_hash'],grant['id'],grant['platform_instance']))
                    await self.check_claim(conn,grant['source_instance'],grant['source_owner'],who.id,grant['physical_identity_hash'])
                manifest=bundle['manifest'];manifest['predecessorHash']=data['predecessorHash'];manifest['sourceBindingHash']=grant['binding_hash'];manifest['grantId']=str(grant_id);manifest['grantRevision']=data['grantRevision'];manifest_hash=sha(canonical(manifest));identifier=uuid4()
                sizes=await(await conn.execute('SELECT octet_length(%s::jsonb::text)+coalesce(octet_length(%s::jsonb::text),0) bytes',(Jsonb(manifest),Jsonb(bundle['fee']) if bundle['fee'] else None))).fetchone()
                needed=len(bundle['raw'])+(len(canonical(bundle['financial'])) if bundle['financial'] else 0)+sizes['bytes']
                if needed>reservation:raise SourceMismatch('source_scope_requires_explicit_segmented_export')
                await conn.execute('INSERT INTO legacy_source_manifests(id,owner_id,grant_id,grant_revision,manifest_sha256,manifest,raw,financial_raw,fee_payload,predecessor_hash) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(identifier,who.id,grant_id,data['grantRevision'],manifest_hash,Jsonb(manifest),bundle['raw'],canonical(bundle['financial']) if bundle['financial'] else None,Jsonb(bundle['fee']) if bundle['fee'] else None,data['predecessorHash']))
                if bundle['financial']:
                    meta=bundle['financial']['source'];await conn.execute('INSERT INTO financial_import_sources(owner_id,id,source_instance,source_owner,source_version,sha256,raw,source_manifest_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,identifier,meta['instance'],meta['owner'],meta['version'],manifest['financialSha256'],canonical(bundle['financial']),identifier))
                    await conn.execute("INSERT INTO legacy_source_view_bindings VALUES(%s,%s,'financial',%s)",(who.id,identifier,manifest['financialSha256']))
                if bundle['fee']:
                    fee=bundle['fee'];digest=fee_fingerprint(fee)
                    if digest!=manifest['feeInventorySha256']:raise SourceMismatch('shared_fee_digest_disagrees')
                    await conn.execute('INSERT INTO fee_legacy_inventory_snapshots(owner_id,source_digest,source_instance,source_owner,complete,order_count,payload,source_manifest_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,source_digest) DO NOTHING',(who.id,digest,definition.instance,grant['source_owner'],manifest['coverage']['complete'],len(fee['orders']),Jsonb(fee),identifier))
                    for entry in fee['orders']:
                        await conn.execute('INSERT INTO fee_legacy_inventory_orders VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(who.id,digest,entry['id'],entry['recordId'],entry['originalBrokerAccountId'],None,None,entry['feeAuthority'],fee_fingerprint(entry['input']),Jsonb(entry)))
                    await conn.execute("INSERT INTO legacy_source_view_bindings VALUES(%s,%s,'fees',%s)",(who.id,identifier,digest))
                    await conn.execute('INSERT INTO fee_legacy_inventory_heads(owner_id,source_digest,revision) VALUES(%s,%s,1) ON CONFLICT(owner_id) DO UPDATE SET source_digest=excluded.source_digest,revision=fee_legacy_inventory_heads.revision+1',(who.id,digest))
                # A prefix conflict remains source evidence; it cannot advance trusted coverage.
                advance=not any(item.get('code')=='source_prefix_conflict' for item in manifest['normalizationBlockers'])
                if advance:
                    if head:
                        advanced=await(await conn.execute('UPDATE legacy_source_heads SET manifest_id=%s,manifest_sha256=%s,revision=revision+1 WHERE owner_id=%s AND manifest_sha256=%s RETURNING revision',(identifier,manifest_hash,who.id,data['predecessorHash']))).fetchone()
                        if not advanced:raise SourceMismatch('source_predecessor_changed_during_commit')
                    else:await conn.execute('INSERT INTO legacy_source_heads(owner_id,manifest_id,manifest_sha256,revision) VALUES(%s,%s,%s,1)',(who.id,identifier,manifest_hash))
                result={'requestId':request,'state':'completed','manifestId':str(identifier),'manifestSha256':manifest_hash,'sourceId':str(identifier) if bundle['financial'] else None,'financialSha256':manifest['financialSha256'],'feeInventorySha256':manifest['feeInventorySha256'],'coverage':manifest['coverage'],'normalizationBlockers':manifest['normalizationBlockers'],'headAdvanced':advance,'financialReady':not manifest['normalizationBlockers'] and bool(bundle['financial']),'financialApplied':False,'sourceBindingHash':grant['binding_hash']}
                await conn.execute("UPDATE legacy_source_operations SET state='completed',result=%s WHERE owner_id=%s AND request_id=%s",(Jsonb(result),who.id,request))
                await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'legacy-source.snapshot-exported',%s,%s)",(who.id,str(identifier),request))
                return result
        except (SourceMismatch,HTTPException,ValueError) as error:
            result={'requestId':request,'state':'failed','financialApplied':False,'failure':'source_read_or_authorization_changed','reason':str(error) if isinstance(error,SourceMismatch) else 'source_authorization_or_normalization_changed','retry':'query_original_uuid'}
            async with self.db.connection() as conn,conn.transaction():
                await self.cash.lock(conn,who)
                await conn.execute("UPDATE legacy_source_operations SET state='failed',result=%s WHERE owner_id=%s AND request_id=%s AND state='reading'",(Jsonb(result),who.id,request))
            return result

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT result FROM legacy_source_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if not row:raise HTTPException(404,'原UUID来源操作不存在')
            return row['result']

    async def grants(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await source_read_lock(conn,who)
            rows=await(await conn.execute('SELECT id,source_alias,source_instance,source_owner,state,revision,platform_instance,binding_hash FROM legacy_source_grants WHERE owner_id=%s ORDER BY created_at,id',(who.id,))).fetchall()
            items=[]
            for row in rows:
                effective=row['state']
                if row["platform_instance"] != self.db.settings.instance_id:
                    effective = "instance_reenrollment_required"
                else:
                    try:
                        self.definition(row)
                    except HTTPException:
                        current = self.registry.get(row["source_alias"])
                        status = current.window_status()["state"] if current else "unavailable"
                        effective = "migration_window_" + status if current and status != "active" else "source_registry_unavailable_or_changed"
                items.append(
                    {
                        **row,
                        "id": str(row["id"]),
                        "platform_instance": str(row["platform_instance"]),
                        "effectiveState": effective,
                        "allowedTables": list(TABLES),
                        "migrationWindow": self.registry[row["source_alias"]].window_status()
                        if row["source_alias"] in self.registry
                        else {"state": "unavailable"},
                    }
                )
            user=await(await conn.execute('SELECT uid FROM users WHERE id=%s',(who.id,))).fetchone()
            return {'targetUserId':who.id,'targetPublicUid':user['uid'],'items':items}

    async def manifest(self,who,identifier):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT manifest,manifest_sha256 FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(who.id,identifier))).fetchone()
            if not row:raise HTTPException(404,'本人来源清单不存在')
            return {'manifest':row['manifest'],'manifestSha256':row['manifest_sha256']}

    async def raw_export(self,who,identifier):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT raw,manifest FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(who.id,identifier))).fetchone()
            if not row:raise HTTPException(404,'本人原始来源快照不存在')
            return bytes(row['raw']),row['manifest']['rawSha256']

    async def budget(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            return await export_budget_status(conn,who.id,self.db.settings.instance_id)


class AuthorizedFinancialImport(FinancialImport):
    def __init__(self,db,authority):super().__init__(db);self.authority=authority

    def command(self,who,raw):
        if not isinstance(raw,dict) or 'targetUserId' not in raw or 'targetUid' in raw or not isinstance(raw['targetUserId'],str):raise HTTPException(422,'请明确提供目标平台内部账号标识targetUserId')
        if raw['targetUserId']!=who.id:raise HTTPException(409,'目标平台内部账号标识与当前本人不匹配')
        if raw.get('confirmedHistoricalOnly') is not True:raise HTTPException(409,'请确认仅导入原始历史记录，不执行券商指令')
        # The frozen base service used a misleading internal key. Keep that
        # compatibility translation private; the product API never calls it UID.
        translated={key:value for key,value in raw.items() if key!='targetUserId'}
        translated['targetUid']=raw['targetUserId']
        return super().command(who,translated)

    @staticmethod
    def identity_result(result):
        result=dict(result)
        if 'targetUid' in result:result['targetUserId']=result.pop('targetUid')
        return result

    async def submit(self,who,raw,preview):
        return self.identity_result(await super().submit(who,raw,preview))

    async def receipt(self,who,request):
        return self.identity_result(await super().receipt(who,request))

    async def plan(self,conn,who,data,cash_revision):
        manifest=await(await conn.execute('SELECT m.* FROM financial_import_sources s JOIN legacy_source_manifests m ON m.id=s.source_manifest_id AND m.owner_id=s.owner_id WHERE s.owner_id=%s AND s.id=%s',(who.id,data['sourceId']))).fetchone()
        if not manifest:raise HTTPException(409,'须先登记来源与本人授权，不能直接上传自证官方资料')
        await self.authority.archive_grant(conn,who,manifest['grant_id'],manifest['grant_revision'],manifest_id=manifest['id'])
        result,*rest=await super().plan(conn,who,data,cash_revision)
        result['targetUserId']=result.pop('targetUid')
        user=await(await conn.execute('SELECT uid FROM users WHERE id=%s',(who.id,))).fetchone()
        result['targetPublicUid']=user['uid']
        blockers=list(manifest['manifest']['normalizationBlockers'])
        stored=json.loads(bytes(manifest['raw']))
        source_accounts={row['id'].get('text'):row for row in stored['tables']['broker_accounts']['rows']}
        for original,target in data['accountMap'].items():
            source_account=source_accounts.get(original)
            current=await(await conn.execute('SELECT provider_id,account_kind,holding_source FROM broker_accounts WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR SHARE',(who.id,target))).fetchone()
            if source_account and current:
                for field in ('provider_id','account_kind','holding_source'):
                    if current[field]!=(source_account.get(field) or {}).get('text'):blockers.append({'code':'source_target_account_identity_mismatch','originalId':original,'field':field})
            elif not source_account:blockers.append({'code':'source_account_mapping_not_authorized','originalId':original})
        if blockers:result['ready']=False;result['blockers']=[*result['blockers'],*blockers];result.pop('preview',None)
        return result,*rest
