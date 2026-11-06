"""Sealed source metadata into the one watch domain; never a financial head or ledger."""

from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity
from .source_budget import reserve
from .source_snapshot import SourceMismatch, canonical, sha
from .source_window import SourceWindowDenied, access_error_message, current_definition, require_source_access
from .watch_group_source_contract import index
from .watch_group_source_registry import load_watch_sources
from .watch_group_source_snapshot import MAX_BYTES, capture
from .watchlists import MARKETS, WatchGroups


class Bound:
    def __init__(self,conn,settings):self.conn,self.settings=conn,settings
    @asynccontextmanager
    async def connection(self):yield self.conn


def identifier(value):
    try:return UUID(str(value))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'原请求编号无效') from None


class WatchGroupImport:
    def __init__(self,db,authority):
        self.db,self.authority=db,authority
        self.after_table=None;self.after_read=None;self.after_step=None;self.after_commit=None

    async def lock(self,conn,who):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        await lock_mutation_identity(conn,who,require_admin=False)
        user=await (await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
        if not user or user['role']!=who.role:raise HTTPException(403,'账号权限已变化')

    def definitions(self,grant):
        definition=current_definition(self.authority.definition(grant))
        registration=load_watch_sources(self.db.settings,self.authority.registry).get(definition.alias)
        if not registration:raise HTTPException(403,'分组来源及结构尚未由操作员登记')
        return definition,registration

    async def prior(self,conn,who,request,fingerprint=None):
        row=await (await conn.execute('SELECT * FROM watch_group_import_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
        if row and fingerprint is not None and row['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于不同操作')
        return row

    async def captured(self,who,grant_id,data):
        request=identifier(data['requestId']);grant_id=identifier(grant_id);fingerprint=sha(canonical({'kind':'watch-capture','grantId':str(grant_id),**data}))
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);previous=await self.prior(conn,who,request,fingerprint)
            if previous:return previous['result']
            grant=await self.authority.grant(conn,who,grant_id,data['grantRevision']);definition,registration=self.definitions(grant)
            try:require_source_access(definition,grant['source_owner'])
            except SourceWindowDenied as exc:raise HTTPException(409,access_error_message(exc)) from None
            reservation=await reserve(conn,who.id,self.db.settings.instance_id)
            metadata_binding=registration.binding(definition)
            accepted={'requestId':str(request),'kind':'capture','state':'reading','retry':'query_original_uuid','platformInstance':str(self.db.settings.instance_id),'reservationBytes':reservation,'financialApplied':False}
            await conn.execute("INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result) VALUES(%s,%s,%s,'capture','reading',%s)",(who.id,request,fingerprint,Jsonb(accepted)))
        async def after_table(table):
            if self.after_table:await self.after_table(table)
            async with self.db.connection() as conn,conn.transaction():
                await self.lock(conn,who)
                operation=await self.prior(conn,who,request)
                if not operation or operation['state']!='reading':raise SourceMismatch('capture_closed')
                require_source_access(definition,grant['source_owner'])
                current=await self.authority.grant(conn,who,grant_id,data['grantRevision']);d,r=self.definitions(current)
                require_source_access(d,current['source_owner'])
                if r.binding(d)!=metadata_binding:raise SourceMismatch('source_watch_registration_changed')
        try:
            snapshot=await capture(definition,registration,grant['source_owner'],after_table=after_table)
            if self.after_read:await self.after_read()
            raw=canonical(snapshot)
            if not 1<=len(raw)<=MAX_BYTES:raise SourceMismatch('watch_source_requires_explicit_segmented_capture')
            manifest={**index(snapshot),'format':'legacy-watch-group-manifest/1','source':snapshot['source'],'rawSha256':sha(raw),'financialApplied':False,'financialHeadAdvanced':False,'metadataBindingHash':metadata_binding}
            if len(raw)+len(canonical(manifest))>reservation:raise SourceMismatch('watch_source_requires_explicit_segmented_capture')
            async with self.db.connection() as conn,conn.transaction():
                await self.lock(conn,who);operation=await (await conn.execute('SELECT * FROM watch_group_import_operations WHERE owner_id=%s AND request_id=%s FOR UPDATE',(who.id,request))).fetchone()
                if operation['state']!='reading':return operation['result']
                grant=await self.authority.grant(conn,who,grant_id,data['grantRevision']);d,r=self.definitions(grant)
                require_source_access(d,grant['source_owner'])
                if r.binding(d)!=metadata_binding:raise SourceMismatch('source_watch_registration_changed')
                await conn.execute('INSERT INTO legacy_source_owner_claims(source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id,platform_instance) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(grant['source_instance'],grant['source_owner'],who.id,grant['physical_identity_hash'],grant['id'],grant['platform_instance']))
                claims=await self.authority.check_claim(conn,grant['source_instance'],grant['source_owner'],who.id,grant['physical_identity_hash'])
                if len(claims)!=1:raise SourceMismatch('source_owner_claim_not_verified')
                manifest_id=uuid4()
                await conn.execute('INSERT INTO watch_group_source_manifests(owner_id,id,request_id,grant_id,grant_revision,source_instance,source_owner,physical_identity_hash,binding_hash,metadata_binding_hash,schema_hash,raw,raw_sha256,manifest) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,manifest_id,request,grant_id,data['grantRevision'],grant['source_instance'],grant['source_owner'],grant['physical_identity_hash'],grant['binding_hash'],metadata_binding,registration.schema_hash,raw,sha(raw),Jsonb(manifest)))
                result={'requestId':str(request),'kind':'capture','state':'completed','manifestId':str(manifest_id),'rawSha256':sha(raw),'counts':manifest['counts'],'metadataCapturedComplete':True,'membershipMappingComplete':False,'iconBytesVerified':False,'financialApplied':False,'financialHeadAdvanced':False}
                await conn.execute("UPDATE watch_group_import_operations SET state='completed',result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s",(Jsonb(result),who.id,request))
                await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'watch-group-source.captured',%s,%s)",(who.id,str(manifest_id),request))
            if self.after_commit:await self.after_commit(result)
            return result
        except Exception as exc:
            # A committed result wins a lost response; source errors never reveal
            # private locator/role/path/password or create a second capture.
            async with self.db.connection() as conn,conn.transaction():
                row=await (await conn.execute('SELECT * FROM watch_group_import_operations WHERE owner_id=%s AND request_id=%s FOR UPDATE',(who.id,request))).fetchone()
                if row['state']!='reading':
                    if row['state']=='completed':raise
                    return row['result']
                reason=str(exc) if isinstance(exc,(SourceMismatch,SourceWindowDenied)) else 'source_capture_failed'
                result={'requestId':str(request),'kind':'capture','state':'failed','reason':reason,'metadataCapturedComplete':False,'financialApplied':False,'financialHeadAdvanced':False,'retry':'new_explicit_uuid_after_review'}
                await conn.execute("UPDATE watch_group_import_operations SET state='failed',result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s",(Jsonb(result),who.id,request))
            return result

    async def manifest_row(self,conn,who,manifest_id,*,authorize=False):
        row=await (await conn.execute('SELECT * FROM watch_group_source_manifests WHERE owner_id=%s AND id=%s',(who.id,manifest_id))).fetchone()
        if not row:raise HTTPException(404,'本人分组来源清单不存在')
        if authorize:
            await self.authority.archive_grant(conn,who,row['grant_id'],row['grant_revision'],manifest_id=row['id'],archive_kind='watch_groups')
        return row

    async def plan(self,conn,who,manifest):
        source=manifest['manifest'];collection=await (await conn.execute('SELECT revision FROM watch_group_collections WHERE owner_id=%s',(who.id,))).fetchone();current={'revision':collection['revision'] if collection else 0}
        group_rows=await (await conn.execute('SELECT * FROM watch_groups WHERE owner_id=%s',(who.id,))).fetchall();by_id={row['id']:row for row in group_rows}
        bindings=await (await conn.execute('SELECT * FROM watch_group_source_bindings WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,manifest['source_instance'],manifest['source_owner']))).fetchall();by_original={r['original_group_id']:r for r in bindings}
        names=[{'id':r['id'],'kind':r['kind'],'market':r['market'],'name_key':r['name_key']} for r in group_rows if r['deleted_at'] is None]
        names.extend({'id':None,'kind':'market','market':market,'name_key':name.lower()} for market,name in MARKETS if not any(r['kind']=='market' and r['market']==market for r in group_rows))
        groups=[];ready={}
        for original in source['groupRows']:
            row=dict(original);reason=row.get('blocker');binding=by_original.get(row['originalId']);target=by_id.get(binding['target_group_id']) if binding else next((r for r in group_rows if r['kind']=='market' and r['market']==row.get('market')),None) if row.get('kind')=='market' else None
            if not reason and binding and (not target or target['deleted_at'] is not None or target['kind']!=row['kind'] or target['market']!=row['market']):reason='mapped_group_changed_or_deleted'
            if not reason and not binding and row['originalId'] in by_id and (target is None or target['id']!=row['originalId']):reason='canonical_id_exists_without_source_binding'
            if not reason and any(n['name_key']==row['nameKey'] and not (target and n['id']==target['id']) and not (row['kind']=='market' and n['kind']=='market' and n['market']==row['market']) for n in names):reason='canonical_name_collision'
            if target and target['icon'] and row.get('iconState')=='empty':row['iconState']='pending_file_clear'
            row.update(state='unknown' if reason else 'ready',reason=reason,targetId=target['id'] if target else row['originalId'] if row.get('kind')=='custom' else None)
            groups.append(row)
            if not reason:ready[row['originalId']]=row
        links=await (await conn.execute("SELECT l.original_id,l.target_id,l.original link_original,r.code,r.market,r.revision,r.watch_group_id,r.watch_group_sort,r.deleted_at FROM financial_import_links l LEFT JOIN portfolio_records r ON r.owner_id=l.owner_id AND r.id=l.target_id WHERE l.owner_id=%s AND l.source_instance=%s AND l.source_owner=%s AND l.object_kind='record'",(who.id,manifest['source_instance'],manifest['source_owner']))).fetchall();records={r['original_id']:r for r in links}
        members=[]
        for original in source['memberRows']:
            row=dict(original);record=records.get(row['originalId']);reason=row.get('blocker');group=ready.get(row.get('groupId'))
            if not reason and (not record or record['revision'] is None or record['deleted_at'] is not None):reason='original_record_binding_missing_or_deleted'
            if not reason and (record['code']!=record['link_original'].get('code') or record['market']!=record['link_original'].get('market')):reason='original_record_identity_changed'
            if not reason and row['groupId'] and group is None:reason='source_group_mapping_unknown'
            if not reason and group and group['kind']!='custom':reason='dynamic_market_group_membership_not_supported'
            row.update(state='unknown' if reason else 'ready',reason=reason,targetRecordId=record['target_id'] if record and record['revision'] is not None and record['deleted_at'] is None else None,recordRevision=record['revision'] if record else None)
            members.append(row)
        collection=await (await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(who.id,))).fetchone()
        plan={'manifestId':str(manifest['id']),'rawSha256':manifest['raw_sha256'],'groupRevision':current['revision'],'recordRevision':collection['revision'] if collection else 0,'groups':groups,'members':members}
        plan['ready']=bool(ready) or any(row['state']=='ready' for row in members) or not groups and not members
        plan['preview']=sha(canonical(plan));return plan

    async def preview(self,who,manifest_id):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await self.lock(conn,who)
            manifest=await self.manifest_row(conn,who,manifest_id,authorize=True);plan=await self.plan(conn,who,manifest)
            return self.public_plan(plan)

    @staticmethod
    def public_plan(plan):
        return {**{k:plan[k] for k in ('manifestId','rawSha256','groupRevision','recordRevision','preview','ready')},'groups':plan['groups'],'members':plan['members'][:100],'memberCount':len(plan['members']),'membersTruncated':len(plan['members'])>100,'unknownGroups':sum(r['state']=='unknown' for r in plan['groups']),'unknownMembers':sum(r['state']=='unknown' for r in plan['members']),'iconPending':sum(str(r.get('iconState','')).startswith('pending_') for r in plan['groups']),'orderingUnknown':sum(r.get('orderingState')!='known' for r in plan['members']),'metadataTimeUnknown':sum(r.get('metadataTimeState')!='known' for r in plan['members']),'financialApplied':False,'financialHeadAdvanced':False}

    async def apply(self,who,manifest_id,data):
        request=identifier(data['requestId']);fingerprint=sha(canonical({'kind':'watch-apply','manifestId':str(manifest_id),**data}))
        try:return await self._apply(who,manifest_id,data)
        except HTTPException:raise
        except Exception:
            async with self.db.connection() as conn,conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
                previous=await self.prior(conn,who,request,fingerprint)
                if previous:
                    if previous['state']=='failed':return previous['result']
                    raise
                result={'requestId':str(request),'kind':'apply','state':'failed','manifestId':str(manifest_id),'reason':'source_apply_rolled_back','retry':'query_original_uuid_then_new_explicit_request_after_review','financialApplied':False,'financialHeadAdvanced':False}
                await conn.execute("INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result,finished_at) VALUES(%s,%s,%s,'apply','failed',%s,clock_timestamp())",(who.id,request,fingerprint,Jsonb(result)))
                return result

    async def _apply(self,who,manifest_id,data):
        request=identifier(data['requestId']);fingerprint=sha(canonical({'kind':'watch-apply','manifestId':str(manifest_id),**data}))
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);previous=await self.prior(conn,who,request,fingerprint)
            if previous:return previous['result']
            manifest=await self.manifest_row(conn,who,manifest_id,authorize=True);plan=await self.plan(conn,who,manifest)
            if data['preview']!=plan['preview'] or data['expectedGroupRevision']!=plan['groupRevision'] or data['expectedRecordRevision']!=plan['recordRevision']:raise HTTPException(409,'分组、成员或映射已变化，请重新核对预览')
            if not plan['ready']:raise HTTPException(409,'清单只有未知映射，尚无可应用项')
            ready_groups=[row for row in plan['groups'] if row['state']=='ready'];ready_members=[row for row in plan['members'] if row['state']=='ready']
            payload={'groups':[{k:row[k] for k in ('originalId','targetId','name','kind','market','sort','visible')} for row in ready_groups],'members':[{'originalRecordId':row['originalId'],'recordId':row['targetRecordId'],'groupOriginalId':row['groupId'],'sort':row['sort'],'expectedRevision':row['recordRevision'],'sourceOrder':row['sourceOrder'],'sourceUpdatedAt':row['sourceUpdatedAt']} for row in ready_members]}
            domain=WatchGroups(Bound(conn,self.db.settings))
            result=await domain.mutate(who.id,'source-import',payload,request,plan['groupRevision'],authorization=who)
            group_map=result['groupMap']
            for position,row in enumerate(ready_groups):
                existing=await (await conn.execute('SELECT target_group_id,kind,market FROM watch_group_source_bindings WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND original_group_id=%s',(who.id,manifest['source_instance'],manifest['source_owner'],row['originalId']))).fetchone()
                if existing:
                    if existing['target_group_id']!=group_map[row['originalId']] or existing['kind']!=row['kind'] or existing['market']!=row['market']:raise HTTPException(409,'原分组映射身份已变化')
                else:
                    await conn.execute('INSERT INTO watch_group_source_bindings(owner_id,source_instance,source_owner,original_group_id,target_group_id,manifest_id,operation_id,source_row_sha256,kind,market) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,manifest['source_instance'],manifest['source_owner'],row['originalId'],group_map[row['originalId']],manifest_id,request,row['rowSha256'],row['kind'],row['market']))
                if self.after_step:await self.after_step(conn,position,row)
            applied={row['originalRecordId']:row for row in result['members']}
            counts={'applied':0,'unchanged':0,'unknown':0}
            for row in plan['members']:
                output=applied.get(row['originalId']) if row['state']=='ready' else None
                state=output['state'] if output else 'unknown';counts[state]+=1
                target_group=output['groupId'] if output else None
                await conn.execute('INSERT INTO watch_group_import_members(owner_id,request_id,manifest_id,sequence,original_record_id,original_group_id,source_row_sha256,target_record_id,target_group_id,state,reason) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,request,manifest_id,row['sequence'],row['originalId'],row.get('groupId'),row['rowSha256'],row['targetRecordId'],target_group,state,row['reason']))
            public=self.public_plan(plan)
            result={'requestId':str(request),'kind':'apply','state':'completed_with_unknown' if public['unknownGroups'] or counts['unknown'] or public['iconPending'] or public['orderingUnknown'] or public['metadataTimeUnknown'] else 'completed','manifestId':str(manifest_id),'rawSha256':manifest['raw_sha256'],'groupMap':group_map,'groupOutcomes':[{**row,'targetId':group_map.get(row['originalId'],row.get('targetId'))} for row in plan['groups']],'memberCounts':counts,'memberCount':len(plan['members']),'groupRevision':result['revision'],'unknownGroups':public['unknownGroups'],'iconPending':public['iconPending'],'orderingUnknown':public['orderingUnknown'],'metadataTimeUnknown':public['metadataTimeUnknown'],'membershipMappingComplete':not public['unknownGroups'] and not counts['unknown'],'iconBytesVerified':False,'financialApplied':False,'financialHeadAdvanced':False}
            await conn.execute("INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result,finished_at) VALUES(%s,%s,%s,'apply','completed',%s,clock_timestamp())",(who.id,request,fingerprint,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'watch-group-source.applied',%s,%s)",(who.id,str(manifest_id),request))
        if self.after_commit:await self.after_commit(result)
        return result

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);row=await self.prior(conn,who,identifier(request))
            if not row:raise HTTPException(404,'本人分组导入原请求不存在')
            return row['result']

    async def close(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);row=await (await conn.execute('SELECT * FROM watch_group_import_operations WHERE owner_id=%s AND request_id=%s FOR UPDATE',(who.id,identifier(request)))).fetchone()
            if not row:raise HTTPException(404,'本人原请求不存在')
            if row['kind']!='capture':raise HTTPException(409,'仅能关闭原取数请求')
            if row['state']!='reading':return row['result']
            result={**{key:row['result'][key] for key in ('domain','manifestId','originalGroupId') if key in row['result']},'requestId':str(request),'kind':'capture','state':'unknown','reason':'capture_closed_without_verified_outcome','retry':'new_explicit_uuid_after_review','metadataCapturedComplete':False,'financialApplied':False,'financialHeadAdvanced':False}
            await conn.execute("UPDATE watch_group_import_operations SET state='unknown',result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s",(Jsonb(result),who.id,identifier(request)))
            return result

    async def manifest(self,who,manifest_id,*,after=0):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);row=await self.manifest_row(conn,who,manifest_id)
            value=row['manifest'];records=value['memberRows']
            grant=await (await conn.execute('SELECT source_alias,state,revision FROM legacy_source_grants WHERE owner_id=%s AND id=%s',(who.id,row['grant_id']))).fetchone()
            definition=self.authority.registry.get(grant['source_alias']) if grant else None
            access={'window':definition.window_status() if definition else {'state':'unavailable'},'grantState':grant['state'] if grant else 'unavailable','grantRevisionMatches':bool(grant and grant['revision']==row['grant_revision'])}
            return {'publishedAt':row['created_at'].isoformat(),'currentSourceAccess':access,'id':str(row['id']),'source':value['source'],'rawSha256':row['raw_sha256'],'counts':value['counts'],'groups':value['groupRows'],'members':records[after:after+100],'next':after+100 if len(records)>after+100 else None,'metadataCapturedComplete':True,'membershipMappingComplete':False,'iconBytesVerified':False,'normalizationBlockers':value['normalizationBlockers'],'financialApplied':False,'financialHeadAdvanced':False}

    async def raw(self,who,manifest_id):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);row=await self.manifest_row(conn,who,manifest_id)
            return bytes(row['raw']),row['raw_sha256']

    async def outcomes(self,who,request,after=0):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who);operation=await self.prior(conn,who,identifier(request))
            if not operation:raise HTTPException(404,'本人原请求不存在')
            rows=await (await conn.execute('SELECT sequence,original_record_id,original_group_id,source_row_sha256,target_record_id,target_group_id,state,reason FROM watch_group_import_members WHERE owner_id=%s AND request_id=%s AND sequence>=%s ORDER BY sequence LIMIT 101',(who.id,identifier(request),after))).fetchall()
            return {'requestId':str(request),'items':rows[:100],'next':rows[100]['sequence'] if len(rows)>100 else None}
