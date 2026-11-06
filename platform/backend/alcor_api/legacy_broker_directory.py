"""Shared broker labels; separate authority from personal account ownership.

Only existing Web-admin authorization can change this global directory. Native
App grants read the public catalog without inheriting administrator privileges.
Rename/removal affects only unassigned display labels and retains all financial
history, owned account identities and immutable shared-image originals.
"""

import json
import re
from contextlib import asynccontextmanager
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .card_preferences import JS_WHITESPACE
from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, native_identity
from .legacy_site_settings import member as legacy_web_member
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import administrator, digest, lock_mutation_identity


def text(value):
    if not isinstance(value, str) or '\x00' in value:
        raise HTTPException(400, '目录文字格式无效')
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeError:
        raise HTTPException(400, '目录文字格式无效') from None
    return value.strip(JS_WHITESPACE)


def normalize(raw):
    if not isinstance(raw, list):
        raise HTTPException(400, 'groups 必须为券商数组 [{ id, name }]')
    if len(raw)>2000:
        raise HTTPException(413, '共享目录超过完整处理上限')
    result, seen = [], set()
    for group in raw:
        if (not isinstance(group, dict) or not isinstance(group.get('id'), str) or not isinstance(group.get('name'), str)
                or 'alias' in group and not isinstance(group['alias'], str)):
            continue
        identifier = text(group['id']).lower()
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        item = {'id': identifier, 'name': text(group['name']) or '未命名券商'}
        alias = text(group['alias']) if 'alias' in group else ''
        if alias:
            item['alias'] = alias
        result.append(item)
    return result


def fingerprint(value):
    return digest(json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False))


class SharedBrokerDirectory:
    def __init__(self, app):
        self.app, self.db = app, app.state.db
        self.settings = app.state.site_settings
        self.catalog = app.state.asset_lookup_catalog
        self.assets = app.state.asset_catalog_management

    @asynccontextmanager
    async def context(self, who, *, write=False):
        async with self.db.connection() as conn, conn.transaction():
            if write:
                if getattr(who, 'grant_id', None) or getattr(who, 'native_client', False):
                    raise HTTPException(403, '需要管理员权限')
                await self.settings.authorize(conn, who)
            else:
                await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute('SELECT pg_advisory_xact_lock'+('' if write else '_shared')+"(hashtextextended('shared-broker-directory',0))")
            yield conn

    async def binding(self, conn, who):
        return await self.app.state.broker_metadata.binding(conn, who)

    async def row(self, conn):
        row = await (await conn.execute('SELECT * FROM shared_broker_directory WHERE singleton')).fetchone()
        if not row:
            raise HTTPException(503, '共享券商目录尚未安装')
        return row

    async def asset_rows(self, conn):
        rows = await (await conn.execute("SELECT e.*,s.manifest->>'publicMetadataConfirmed' AS public_metadata_confirmed FROM asset_catalog_entries e JOIN asset_catalog_sources s ON s.id=e.source_id WHERE e.type='broker' AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY id LIMIT 10001")).fetchall()
        if len(rows)>10000:
            raise HTTPException(503, '共享券商图标目录超出完整读取范围')
        return rows

    async def brokers(self, conn, groups):
        async with self.catalog.context(connection=conn):
            icons, cache, budget = {}, {}, {'bytes': 0, 'verified': set()}
            for row in await self.asset_rows(conn):
                projected = await self.catalog.project(conn, row, cache, budget)
                icons[row['code'].lower()] = projected.get('imageUrl') or ''
            return [{'id': group['id'], 'name': group['name'], 'alias': group.get('alias', ''),
                     'icon': icons.get(group['id'].lower(), '')} for group in groups]

    async def read(self, who):
        async with self.context(who) as conn:
            row = await self.row(conn)
            return {'revision': row['revision'], 'groups': row['groups'], 'brokers': await self.brokers(conn,row['groups']),
                    'coverage': 'shared_directory_only', 'historicalCoverageKnown': False,
                    'personalAccounts': False, 'financialFieldsChanged': False}

    async def plan(self, conn, before, groups):
        old, new = {group['id']:group for group in before}, {group['id']:group for group in groups}
        renamed = [{'id':key,'from':value['name'],'to':new[key]['name']} for key,value in old.items() if key in new and new[key]['name']!=value['name']]
        removed = [{'id':key,'name':value['name']} for key,value in old.items() if key not in new]
        personal = await (await conn.execute('SELECT DISTINCT name FROM broker_accounts WHERE deleted_at IS NULL')).fetchall()
        names = {row['name'].lower() for row in personal}
        if any(value.lower() in names for group in groups for value in (group['name'],group.get('alias','')) if value):
            raise HTTPException(409, '共享券商名称不能覆盖个人账户名称')
        labels={}
        retained_names={group['name'] for group in groups}
        for item in renamed:
            if item['from'] in labels and labels[item['from']]!=item['to']:
                raise HTTPException(409,'同名共享分组的改名目标不明确')
            labels[item['from']]=item['to']
        for item in removed:
            if item['name'] not in labels and item['name'] not in retained_names:
                labels[item['name']]=''
        affected = await (await conn.execute('SELECT count(*) AS n FROM portfolio_records WHERE deleted_at IS NULL AND broker_account_id IS NULL AND group_name=ANY(%s)', (list(labels),))).fetchone()
        return {'renamed':renamed,'removed':removed,'affectedUnassignedRecords':affected['n'],'labelChanges':[{'from':old,'to':new} for old,new in labels.items()],
                'financialFieldsChanged':False,'originalsDeleted':False}

    async def preview(self, who, request, revision, groups):
        groups = normalize(groups)
        async with self.context(who,write=True) as conn:
            row=await self.row(conn)
            if type(revision) is not int or row['revision']!=revision:
                raise HTTPException(409, '共享目录已变化，请重新读取')
            plan=await self.plan(conn,row['groups'],groups)
            identifier=uuid4()
            expiry=await (await conn.execute('INSERT INTO shared_broker_directory_previews(actor_id,id,request_id,revision,groups,fingerprint,authorization_binding,plan) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at',
                (who.id,identifier,UUID(str(request)),revision,Jsonb(groups),fingerprint(groups),await self.binding(conn,who),Jsonb(plan)))).fetchone()
            return jsonable_encoder({'requestId':str(request),'previewId':str(identifier),'revision':revision,'groups':groups,
                                     'beforeGroups':row['groups'],**plan,'expiresAt':expiry['expires_at']})

    async def save(self, who, request, groups=None, *, revision=None, preview_id=None, delete_id=None, generated=False):
        request=UUID(str(request))
        normalized=normalize(groups) if delete_id is None else None
        operation={'groups':normalized,'revision':revision,'deleteId':delete_id,'previewId':str(preview_id) if preview_id else None}
        fp=fingerprint(operation)
        async with self.context(who,write=True) as conn:
            prior=await (await conn.execute('SELECT fingerprint,result FROM shared_broker_directory_operations WHERE actor_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if prior:
                if prior['result'].get('state')=='closed':
                    return prior['result']
                if prior['fingerprint']!=fp:
                    raise HTTPException(409,'原操作编号已用于其他目录操作')
                return prior['result']
            row=await self.row(conn)
            if revision is not None and (type(revision) is not int or row['revision']!=revision):
                raise HTTPException(409,'共享目录已变化，请重新读取')
            if row['revision']>=9007199254740990:
                raise HTTPException(409,'共享目录修订已达上限')
            if delete_id is not None:
                if not any(group['id'].lower()==delete_id for group in row['groups']):
                    raise HTTPException(404,'券商不存在')
                normalized=[group for group in row['groups'] if group['id'].lower()!=delete_id]
            plan=await self.plan(conn,row['groups'],normalized)
            if preview_id is not None:
                preview=await (await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM shared_broker_directory_previews WHERE actor_id=%s AND id=%s',(who.id,UUID(str(preview_id))))).fetchone()
                if (not preview or not preview['valid'] or str(preview['request_id'])!=str(request) or preview['revision']!=row['revision']
                        or preview['fingerprint']!=fingerprint(normalized) or preview['authorization_binding']!=await self.binding(conn,who)
                        or preview['plan']!=plan):
                    raise HTTPException(409,'共享目录预览、会话或关联标签已变化')
            # Rename only free-standing labels, never records bound to a personal account.
            labels={item['from']:item['to'] for item in plan['labelChanges']}
            if labels:
                cases=' '.join('WHEN %s THEN %s' for _ in labels)
                parameters=[value for pair in labels.items() for value in pair]
                await conn.execute('UPDATE portfolio_records SET group_name=CASE group_name '+cases+' ELSE group_name END,updated_at=clock_timestamp() WHERE deleted_at IS NULL AND broker_account_id IS NULL AND group_name=ANY(%s)',(*parameters,list(labels)))
            async with self.catalog.context(who,True,connection=conn):
                asset_rows=await self.asset_rows(conn)
                new_names={group['id'].lower():group['name'] for group in normalized}
                for asset in asset_rows:
                    code=asset['code'].lower()
                    action='delete' if delete_id is not None and code==delete_id else 'rename' if code in new_names and asset['name']!=new_names[code] and asset['public_metadata_confirmed']=='true' else None
                    if action is None:
                        continue
                    asset_revision=(await (await conn.execute('SELECT revision FROM asset_catalog_scope FOR UPDATE')).fetchone())['revision']
                    child=uuid5(request,'shared-broker-asset:'+asset['id'])
                    if action=='delete':
                        await self.assets.delete(who,child,asset_revision,asset['id'],connection=conn)
                    else:
                        await self.assets.write(who,child,asset_revision,{'id':asset['id'],'name':new_names[code]},rename=True,connection=conn)
            await conn.execute('UPDATE shared_broker_directory SET groups=%s,revision=revision+1,updated_at=clock_timestamp() WHERE singleton',(Jsonb(normalized),))
            result={'requestId':str(request),'state':'completed','revision':row['revision']+1,'groups':normalized,
                    'brokers':await self.brokers(conn,normalized),**plan,'legacyRequestIdGenerated':generated}
            await conn.execute('INSERT INTO shared_broker_directory_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request,fp,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'shared-broker-directory.save',%s)",(who.id,request))
            return result

    async def receipt(self,who,request,*,close=False):
        request=UUID(str(request))
        async with self.context(who,write=True) as conn:
            row=await (await conn.execute('SELECT result FROM shared_broker_directory_operations WHERE actor_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if row:return row['result']
            if not close:raise HTTPException(404,'原目录操作回执不存在')
            result={'requestId':str(request),'state':'closed','executed':False}
            await conn.execute('INSERT INTO shared_broker_directory_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request,fingerprint(result),Jsonb(result)))
            return result


def mount_legacy_broker_directory(app):
    service=SharedBrokerDirectory(app)
    app.state.shared_broker_directory=service

    async def member(request,version=None,admin=False):
        if version is None:
            return await administrator(request)
        authorization=request.headers.get('authorization','')
        if authorization.startswith('Bearer fat_'):
            assert_native_origin(request,app.state.db.settings)
            who,grant=await native_identity(request,app.state.db,'portfolio.read')
            if grant['client_id']!=CLIENT:raise HTTPException(401,'未登录')
            if admin:raise HTTPException(403,'需要管理员权限')
            return who
        if version==2:raise HTTPException(401,'未登录')
        who=await legacy_web_member(request,app.state.db)
        if admin and who.role!='admin':raise HTTPException(403,'需要管理员权限')
        return who

    async def body(request):
        try:
            value=json.loads(await bounded_body(request,65536),object_pairs_hook=unique,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError,UnicodeError,RecursionError):
            raise HTTPException(400,'目录请求格式无效') from None
        if not isinstance(value,dict):raise HTTPException(400,'目录请求格式无效')
        return value

    async def execute(request,action,version=None,request_id=None):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        if version:headers['X-Alcor-API-Version']=str(version)
        try:
            who=await member(request,version,admin=action!='read')
            if action=='read':result=await service.read(who)
            elif action in ('receipt','close'):
                if action=='close' and (await bounded_body(request,128)).strip() not in (b'',b'{}'):
                    raise HTTPException(400,'关闭请求字段无效')
                result=await service.receipt(who,request_id,close=action=='close')
            else:
                raw=await body(request) if request.method!='DELETE' else {}
                provided=raw.get('requestId') if version is None else request.headers.get('x-alcor-request-id')
                expected=raw.get('expectedRevision') if version is None else request.headers.get('x-alcor-directory-revision')
                if version and ((provided is None)!=(expected is None)):
                    raise HTTPException(400,'请同时提供原操作编号和共享目录版本')
                identifier=UUID(str(provided)) if provided is not None else uuid4()
                if version and expected is not None:
                    if not re.fullmatch(r'0|[1-9][0-9]*',expected,re.ASCII):raise HTTPException(400,'共享目录版本无效')
                    expected=int(expected)
                if version is None and (provided is None or type(expected) is not int):raise HTTPException(400,'目录操作编号或版本无效')
                if action=='preview':result=await service.preview(who,identifier,expected,raw.get('groups'))
                elif action=='save':
                    if version is None and set(raw)!={'requestId','expectedRevision','groups','previewId'}:
                        raise HTTPException(400,'目录确认字段无效')
                    result=await service.save(who,identifier,raw.get('groups'),revision=expected,preview_id=raw.get('previewId') if version is None else None,generated=provided is None)
                else:
                    identifier_text=text(request.query_params.get('id','')).lower()
                    if not identifier_text:raise HTTPException(400,'缺少券商 id')
                    result=await service.save(who,identifier,revision=expected,delete_id=identifier_text,generated=provided is None)
                headers['X-Alcor-Request-Id']=str(identifier)
            if 'revision' in result:headers['X-Alcor-Directory-Revision']=str(result['revision'])
            if version:
                payload=result['brokers'] if action=='read' or result.get('state')=='completed' else result
                return JSONResponse({'code':0,'message':'ok','data':payload},headers=headers)
            return JSONResponse(result,headers=headers)
        except (ValueError,TypeError):
            error=HTTPException(400,'目录参数格式无效')
        except HTTPException as exc:error=exc
        if error.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
        return JSONResponse({'code':40902 if error.status_code==409 else error.status_code*100+1,'message':str(error.detail)} if version else {'error':str(error.detail)},status_code=error.status_code,headers=headers)

    @app.get('/api/v1/brokers')
    async def v1_read(request:Request):return await execute(request,'read',1)
    @app.get('/api/v2/brokers')
    async def v2_read(request:Request):return await execute(request,'read',2)
    @app.post('/api/v1/brokers')
    async def v1_save(request:Request):return await execute(request,'save',1)
    @app.delete('/api/v1/brokers')
    async def v1_delete(request:Request):return await execute(request,'delete',1)
    @app.get('/api/admin/shared-brokers')
    async def state(request:Request):return await execute(request,'read')
    @app.post('/api/admin/shared-brokers/preview')
    async def preview(request:Request):return await execute(request,'preview')
    @app.post('/api/admin/shared-brokers/operations')
    async def save(request:Request):return await execute(request,'save')
    @app.get('/api/admin/shared-brokers/operations/{request_id}')
    async def receipt(request_id:UUID,request:Request):return await execute(request,'receipt',request_id=request_id)
    @app.post('/api/admin/shared-brokers/operations/{request_id}/close')
    async def close(request_id:UUID,request:Request):return await execute(request,'close',request_id=request_id)
