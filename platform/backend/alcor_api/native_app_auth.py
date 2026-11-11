"""Native fire-ios grant/token semantics; independent of legacy backend availability."""
import re
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from .security import Identity, digest

CLIENT='fire-ios'
REDIRECT='com.fire.app:/oauth/callback'
BASE_SCOPE='portfolio.read portfolio.write'
SCOPES=set(BASE_SCOPE.split())|{'assets.read','positions.read','cash.read','orders.read','orders.write','orders.cancel','profile.write','feed.read','feed.write','security.read','security.write','resources.read','resources.write'}


def parse_scopes(value):
    if not isinstance(value,str) or len(value)>512:raise HTTPException(400,'请求权限无效')
    scopes=list(dict.fromkeys(value.split()))
    if not scopes or not set(scopes)<=SCOPES or 'portfolio.read' not in scopes:
        raise HTTPException(403,'不支持的授权范围')
    for prefix in ('feed','security','resources'):
        if prefix+'.write' in scopes and prefix+'.read' not in scopes:raise HTTPException(403,'不支持的授权范围')
    return ' '.join(scopes)


def opaque(prefix):return prefix+secrets.token_urlsafe(32)


async def security_stamp(conn,user):
    factor=await (await conn.execute('SELECT source_stamp,totp_enabled,totp_secret_ciphertext FROM identity_security WHERE user_id=%s',(user['id'],))).fetchone()
    if factor and factor['source_stamp']:return factor['source_stamp']
    return digest(f'{user["password_hash"]}:{int(bool(factor and factor["totp_enabled"]))}:{factor["totp_secret_ciphertext"] if factor else ""}')


async def token_pair(conn,grant_id):
    access,refresh=opaque('fat_'),opaque('frt_')
    await conn.execute("INSERT INTO identity_app_access_tokens(token_hash,grant_id,expires_at) VALUES(%s,%s,clock_timestamp()+interval '15 minutes')",(digest(access),grant_id))
    await conn.execute('INSERT INTO identity_app_refresh_tokens(token_hash,grant_id) VALUES(%s,%s)',(digest(refresh),grant_id))
    return {'access_token':access,'refresh_token':refresh,'token_type':'Bearer','expires_in':900,'grant_id':grant_id}


async def issue_grant(conn,user,scope,device_name,passkey_id=None,preserve_grant_id=None):
    scope=parse_scopes(scope);now=datetime.now(UTC)
    await consent_descriptor(conn,user)
    old=await (await conn.execute('SELECT id FROM identity_app_grants WHERE user_id=%s AND (%s::text IS NULL OR id<>%s) ORDER BY created_at DESC,id DESC OFFSET %s',(user['id'],preserve_grant_id,preserve_grant_id,18 if preserve_grant_id else 19))).fetchall()
    if old:await conn.execute('DELETE FROM identity_app_grants WHERE id=ANY(%s)',([row['id'] for row in old],))
    grant_id=opaque('fg_')
    await conn.execute('''INSERT INTO identity_app_grants(id,user_id,client_id,scope,device_name,security_stamp,session_version,passkey_id,created_at,last_used_at,expires_at)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(grant_id,user['id'],CLIENT,scope,device_name,await security_stamp(conn,user),user['session_version'],passkey_id,now,now,now+timedelta(days=30)))
    return {**await token_pair(conn,grant_id),'scope':scope}


async def active_grant(conn,grant_id,*,lock=False,shared=False):
    row=await (await conn.execute('''SELECT g.*,u.username,u.email,u.password_hash,u.role,u.active,u.session_version AS current_version,
        g.expires_at>clock_timestamp() AND g.created_at+interval '90 days'>clock_timestamp() AS valid
        FROM identity_app_grants g JOIN users u ON u.id=g.user_id WHERE g.id=%s'''+(' FOR SHARE OF g,u' if shared else ' FOR UPDATE OF g,u' if lock else ''),(grant_id,))).fetchone()
    if not row or not row['valid'] or row['revoked_at'] or not row['active'] or row['session_version']!=row['current_version']:return None
    user={**row,'id':row['user_id']}
    if row['security_stamp']!=await security_stamp(conn,user):return None
    if row['passkey_id'] and not await (await conn.execute('SELECT 1 FROM identity_passkeys WHERE id=%s AND user_id=%s',(row['passkey_id'],row['user_id']))).fetchone():return None
    return row


async def authenticate(conn,token,scope=None,*,lock=False,shared=False):
    if not re.fullmatch(r'fat_[A-Za-z0-9_-]{43}',token):raise HTTPException(401,'需要有效的 App 连接')
    row=await (await conn.execute("SELECT grant_id FROM identity_app_access_tokens WHERE token_hash=%s AND expires_at>clock_timestamp()",(digest(token),))).fetchone()
    grant=await active_grant(conn,row['grant_id'],lock=lock,shared=shared) if row else None
    if not grant:raise HTTPException(401,'连接已失效，请重新连接')
    if scope and scope not in grant['scope'].split():raise HTTPException(403,'连接缺少此操作的授权范围')
    from .request_activity import bind_account
    bind_account(grant['user_id'])
    return grant


async def rotate(conn,client_id,refresh):
    if client_id!=CLIENT or not re.fullmatch(r'frt_[A-Za-z0-9_-]{43}',refresh):return None
    row=await (await conn.execute('SELECT * FROM identity_app_refresh_tokens WHERE token_hash=%s FOR UPDATE',(digest(refresh),))).fetchone()
    grant=await active_grant(conn,row['grant_id'],lock=True) if row else None
    if not grant:return None
    if row['used_at']:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s',(grant['id'],))
        return None
    await conn.execute('UPDATE identity_app_refresh_tokens SET used_at=clock_timestamp() WHERE token_hash=%s',(digest(refresh),))
    await conn.execute("UPDATE identity_app_grants SET expires_at=LEAST(created_at+interval '90 days',clock_timestamp()+interval '30 days'),last_used_at=clock_timestamp() WHERE id=%s",(grant['id'],))
    return {**await token_pair(conn,grant['id']),'scope':grant['scope']}


async def lock_native_mutation(conn,who):
    return await lock_native_identity(conn,who)


async def lock_native_identity(conn,who,*,shared=False):
    # Reads hold the same current credential proof through commit, but do not
    # serialize independent reads. Rotation/revocation still requires UPDATE.
    grant=await authenticate(conn,who.native_access_token,lock=not shared,shared=shared)
    if grant['id']!=who.grant_id or grant['user_id']!=who.id:raise HTTPException(401,'操作授权已变化，请重新登录核对')
    if getattr(who,'required_scope',None) and who.required_scope not in grant['scope'].split():raise HTTPException(403,'连接缺少此操作的授权范围')
    return grant


def identity_from_grant(grant,token,scope=None):
    who=Identity(id=grant['user_id'],username=grant['username'],role=grant['role'],token_hash=digest(token),csrf='',expires_at=grant['expires_at'])
    who.grant_id=grant['id'];who.native_access_token=token;who.native_client=True;who.required_scope=scope
    return who

async def remember_consent(conn,user,scope):
    scope=parse_scopes(scope)
    await conn.execute('''INSERT INTO identity_app_consents(user_id,client_id,scope,security_stamp,revision,updated_at) VALUES(%s,%s,%s,%s,%s,clock_timestamp())
        ON CONFLICT(user_id,client_id) DO UPDATE SET scope=excluded.scope,security_stamp=excluded.security_stamp,revision=excluded.revision,updated_at=excluded.updated_at''',(user['id'],CLIENT,scope,await security_stamp(conn,user),opaque('fcr_')))


async def consent_descriptor(conn,user):
    stamp=await security_stamp(conn,user)
    saved=await (await conn.execute('SELECT * FROM identity_app_consents WHERE user_id=%s AND client_id=%s',(user['id'],CLIENT))).fetchone()
    if saved:return {'scope':saved['scope'] if saved['security_stamp']==stamp else BASE_SCOPE,'revision':digest(saved['revision']+stamp)}
    chosen=BASE_SCOPE
    grants=await (await conn.execute('SELECT id FROM identity_app_grants WHERE user_id=%s AND revoked_at IS NULL ORDER BY created_at DESC,id DESC',(user['id'],))).fetchall()
    for candidate in grants:
        grant=await active_grant(conn,candidate['id'])
        if not grant:continue
        try:scope=parse_scopes(grant['scope'])
        except HTTPException:continue
        if set(scope.split())-set(BASE_SCOPE.split()):chosen=scope;break
    await remember_consent(conn,user,chosen)
    return await consent_descriptor(conn,user)


async def revoke_presented_token(conn,token,request_id):
    """Revoke this native token family once; caller owns the audit transaction."""
    if not re.fullmatch(r'(fat|frt)_[A-Za-z0-9_-]{43}',token):return False
    table='identity_app_access_tokens' if token.startswith('fat_') else 'identity_app_refresh_tokens'
    found=await(await conn.execute(f'SELECT g.id,g.user_id FROM identity_app_grants g JOIN {table} t ON t.grant_id=g.id WHERE t.token_hash=%s',(digest(token),))).fetchone()
    if not found:return False
    from psycopg.errors import LockNotAvailable
    try:
        await conn.execute('SELECT id FROM users WHERE id=%s FOR NO KEY UPDATE NOWAIT',(found['user_id'],))
        await conn.execute('SELECT id FROM identity_app_grants WHERE id=%s FOR UPDATE NOWAIT',(found['id'],))
    except LockNotAvailable:
        raise HTTPException(503,'连接状态正在变化，请核对后重试') from None
    row=await(await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s AND revoked_at IS NULL RETURNING id,user_id',(found['id'],))).fetchone()
    if row:
        from .broker_position_transfers import purge_broker_position_transfer_previews
        await purge_broker_position_transfer_previews(conn, row['user_id'])
        from .fund_sources import purge_fund_source_previews
        await purge_fund_source_previews(conn, row['user_id'])
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'identity.app.revoked',%s,%s)",(row['user_id'],row['id'],request_id))
    return bool(row)
