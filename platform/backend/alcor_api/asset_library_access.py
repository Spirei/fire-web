"""Material browsing tiers; publication and private owner media keep existing authorities."""
import hashlib
import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .profile_http import bounded_body
from .security import COOKIE, administrator, identity, lock_mutation_identity


async def read_access(conn):
    row = await (await conn.execute('SELECT revision,registered,guest FROM asset_library_access WHERE singleton')).fetchone()
    if row is None:
        raise HTTPException(503, '素材权限尚未初始化')
    return dict(row)


async def material_member(request, db):
    if 'authorization' in request.headers:
        if re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', request.headers['authorization']):
            from .legacy_identity import native_identity
            return (await native_identity(request, db))[0]
        from .card_preferences_protocol import card_member
        return await card_member(request, db)
    if COOKIE in request.cookies:
        return await identity(request)
    from .card_preferences_protocol import card_member
    return await card_member(request, db)


async def assert_material_read(request, db):
    async with db.connection() as conn:
        policy = await read_access(conn)
    if policy['guest']:
        return policy
    try:
        who = await material_member(request, db)
    except HTTPException as exc:
        raise HTTPException(exc.status_code, '请登录后读取素材' if exc.status_code == 401 else str(exc.detail), headers={'Cache-Control':'private, no-store', 'Vary':'Cookie, Authorization'}) from None
    if who.role != 'admin' and not policy['registered']:
        raise HTTPException(403, '素材库仅向管理员开放', headers={'Cache-Control':'private, no-store', 'Vary':'Cookie, Authorization'})
    return policy


def mount_material_access(app, db):
    headers={'Cache-Control':'private, no-store', 'Vary':'Cookie, Authorization'}

    @app.get('/api/asset-library/access')
    async def public_access():
        async with db.connection() as conn:
            return JSONResponse(await read_access(conn), headers=headers)

    @app.get('/api/admin/asset-library/access')
    async def admin_access(request: Request):
        await administrator(request)
        async with db.connection() as conn:
            return JSONResponse(await read_access(conn), headers=headers)

    @app.get('/api/admin/asset-library/access/operations/{request_id}')
    async def operation(request_id: UUID, request: Request):
        who=await administrator(request)
        async with db.connection() as conn:
            row=await (await conn.execute('SELECT result FROM asset_library_access_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
        if row is None: raise HTTPException(404, '尚未找到原权限操作')
        return JSONResponse(row['result'],headers=headers)

    @app.post('/api/admin/asset-library/access')
    async def save(request: Request):
        who=await administrator(request)
        try:
            def pairs(values):
                result={}
                for k,v in values:
                    if k in result: raise ValueError()
                    result[k]=v
                return result
            raw=json.loads(await bounded_body(request, 2048), object_pairs_hook=pairs)
            if set(raw) != {'requestId','expectedRevision','registered','guest'} or type(raw['expectedRevision']) is not int or not 0 <= raw['expectedRevision'] < 9007199254740990 or type(raw['registered']) is not bool or type(raw['guest']) is not bool or raw['guest'] and not raw['registered']:
                raise ValueError()
            uid=UUID(raw['requestId'])
        except (ValueError,TypeError,AttributeError,UnicodeError):
            raise HTTPException(400, '素材权限字段无效') from None
        fp=hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        async with db.connection() as conn, conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await lock_mutation_identity(conn,who)
            old=await (await conn.execute('SELECT * FROM asset_library_access WHERE singleton FOR UPDATE')).fetchone()
            prior=await (await conn.execute('SELECT fingerprint,result FROM asset_library_access_operations WHERE actor_id=%s AND request_id=%s',(who.id,uid))).fetchone()
            if prior:
                if prior['fingerprint'] != fp: raise HTTPException(409,'原权限编号已用于其他内容')
                return JSONResponse(prior['result'],headers=headers)
            if old['revision'] != raw['expectedRevision']: raise HTTPException(409,'素材权限已变化，请重新读取')
            await conn.execute('UPDATE asset_library_access SET revision=revision+1,registered=%s,guest=%s WHERE singleton',(raw['registered'],raw['guest']))
            result={'requestId':str(uid),**await read_access(conn)}
            await conn.execute('INSERT INTO asset_library_access_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,uid,fp,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'asset-library.access','public-materials',%s)",(who.id,uid))
            return JSONResponse(result,headers=headers)
