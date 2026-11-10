"""Legacy Web/iOS protocol adapters over native platform identity/domain services."""
import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urlsplit
from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb
from .models import LoginInput
from .passwords import DUMMY_HASH, verify_password
from .security import COOKIE, Identity, digest, trusted_origin, identity, csrf_token
from .identity_service import FACTOR_COOKIE
from .native_app_auth import CLIENT, REDIRECT, BASE_SCOPE, SCOPES, authenticate, issue_grant, active_grant, rotate, identity_from_grant, parse_scopes, security_stamp, opaque, remember_consent, consent_descriptor

WEB_COOKIE='fire_session'
OLD_COOKIE='stocklog_session'
LEGACY_WEB_PATHS = {
    "/api/assets/catalog", "/api/auth/personal-home", "/api/auth/personal-activity", "/api/auth/search-history",
    "/api/auth/profile", "/api/upload", "/api/auth/avatar",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/verify",
    "/api/auth/password-reset/confirm",
    '/api/auth/login', '/api/auth/login/totp', '/api/auth/logout',
    '/api/auth/me', '/api/auth/register', '/api/auth/setup-status', '/api/auth/totp',
    '/api/auth/passkeys', '/api/auth/passkeys/config', '/api/auth/passkeys/verification',
    '/api/auth/password',
    '/api/auth/register/email/request', '/api/auth/register/email/confirm',
    '/api/auth/email-verification/request', '/api/auth/email-verification/confirm',
}


class LegacyError(HTTPException):
    def __init__(self,status,code,message):
        super().__init__(status,message)
        self.business_code=code


def native_version(request):
    if request.url.path.startswith('/api/client/auth/') and getattr(request.state,'canonical_security_v2',False):
        return 2
    value=request.path_params.get('version')
    if value is None:
        match=re.match(r'^/api/v([12])/',request.url.path)
        value=int(match[1]) if match else None
    if value in ('1','2'):value=int(value)
    if value not in (1,2):raise LegacyError(404,40401,'接口不存在')
    return value


def assert_native_origin(request,settings):
    actual=f'{request.url.scheme}://{request.url.netloc}'
    token = request.cookies.get(COOKIE, '')
    binding = request.headers.get("x-csrf-token", "")
    bound_web = bool(
        actual != settings.public_origin
        and not getattr(settings, "trusted_proxy_ips", ())
        and token and len(token) <= 128
        and "authorization" not in request.headers
        and len(binding) == 64 and binding.isascii()
        and secrets.compare_digest(binding, csrf_token(token))
    )
    # A bound Web session is checked again by the route's identity service.
    # An explicit proxy policy must still match the translated scheme and authority.
    if request.headers.get('origin') not in (None,settings.public_origin) or request.headers.get('sec-fetch-site')=='cross-site' or (actual!=settings.public_origin and not bound_web):
        raise LegacyError(403,40301,'请求来源不受信任')


def envelope(data,request,response):
    response.headers['Cache-Control']='no-store, private'
    response.headers['X-Alcor-API-Version']=str(native_version(request))
    return {'code':0,'message':'ok','data':data}


async def body(request,fields,limit=16384):
    raw=await request.body()
    try:
        if len(raw)>limit:raise ValueError()
        data=json.loads(raw)
        if not isinstance(data,dict) or set(data)-set(fields):raise ValueError()
        for value in data.values():
            if isinstance(value,str):value.encode('utf-8')
        return data
    except Exception:raise LegacyError(400,40002,'请求参数无效') from None


async def legacy_session(conn,token,*,native_v1=False,platform=False):
    if not token or len(token)>128:raise LegacyError(401,40101,'请先登录')
    clients=['legacy-web','legacy-v1'] if native_v1 else (['new-web'] if platform else ['legacy-web'])
    row=await (await conn.execute('''SELECT u.*,s.expires_at,s.auth_method,s.passkey_id,s.created_at AS authenticated_at FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=%s AND s.client_id=ANY(%s) AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version AND u.active
        AND (COALESCE(s.passkey_id,'')='' OR EXISTS
            (SELECT 1 FROM identity_passkeys p WHERE p.id=s.passkey_id AND p.user_id=u.id))''',(digest(token),clients))).fetchone()
    if not row:raise LegacyError(401,40102,'登录已失效，请重新登录')
    from .request_activity import bind_account
    bind_account(row['id'])
    return row


def legacy_me_mutation_trusted(request):
    """Old active check. A missing Origin is allowed unless the fetch site is cross-site."""
    origin = request.headers.get("origin") or ""
    if not origin:
        return request.headers.get("sec-fetch-site") != "cross-site"
    parsed = urlsplit(origin)
    host = (request.headers.get("host") or request.url.netloc).lower()
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host


async def web_identity(
    request,db,*,allow_platform=False,allow_v1_bearer=False,allow_legacy_bearer=False,origin_checked=False,web_bearer_only=False,
):
    if allow_platform and request.headers.get('x-csrf-token'):
        who=await identity(request)
        async with db.connection() as conn:
            row=await (await conn.execute('SELECT * FROM users WHERE id=%s',(who.id,))).fetchone()
        return who,row,request.cookies.get(COOKIE,'')
    authorization=request.headers.get('authorization','')
    bearer=authorization.removeprefix('Bearer ') if authorization.startswith('Bearer ') else ''
    if web_bearer_only:bearer=bearer.strip()
    if bearer and not allow_v1_bearer and not allow_legacy_bearer:raise LegacyError(403,40301,'请使用网页登录会话')
    if request.method not in ('GET','HEAD','OPTIONS') and not bearer and not origin_checked:trusted_origin(request)
    token=bearer or request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or (request.cookies.get(COOKIE) if allow_platform else '')
    platform=bool(allow_platform and not bearer and not request.cookies.get(WEB_COOKIE) and not request.cookies.get(OLD_COOKIE) and request.cookies.get(COOKIE))
    async with db.connection() as conn:
        row=await legacy_session(conn,token,native_v1=bool(bearer) and not web_bearer_only,platform=platform)
    who=Identity(id=row['id'],username=row['username'],role=row['role'],token_hash=digest(token),csrf='',expires_at=row['expires_at'])
    who.legacy_client=True
    who.legacy_platform=platform
    return who,row,token


async def native_identity(request,db,scope=None):
    token=request.headers.get('authorization','').removeprefix('Bearer ')
    async with db.connection() as conn:
        grant=await authenticate(conn,token,scope)
    return identity_from_grant(grant,token,scope),grant


PUBLIC_PROFILE_QUERY = 'SELECT u.id,u.uid,u.is_test,u.username,u.email,u.role,u.created_at,p.display_name,(p.avatar IS NOT NULL OR p.avatar_object_id IS NOT NULL) AS has_avatar,p.revision AS profile_revision,m.metadata,s.totp_enabled,s.email_verified\n        FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN identity_source_profiles m ON m.user_id=u.id LEFT JOIN identity_security s ON s.user_id=u.id'


async def public_profile(conn,user_id,*,scope=None,settings=None):
    user=await(await conn.execute(PUBLIC_PROFILE_QUERY+' WHERE u.id=%s',(user_id,))).fetchone()
    availability = None
    if scope is not None and settings is not None:
        from .native_identity_capabilities import email_verification_availability
        availability = await email_verification_availability(conn, settings)
    return profile_value(user,scope=scope,email_availability=availability)


async def public_profiles(conn,user_ids,*,scope=None,settings=None):
    rows=await(await conn.execute(PUBLIC_PROFILE_QUERY+' WHERE u.id=ANY(%s)',(user_ids,))).fetchall()
    availability = None
    if scope is not None and settings is not None:
        from .native_identity_capabilities import email_verification_availability
        availability = await email_verification_availability(conn, settings)
    return {user['id']:profile_value(user,scope=scope,email_availability=availability) for user in rows}


def profile_value(user,*,scope=None,email_availability=None):
    metadata=user['metadata'] or {}
    value={'id':user['id'],'username':user['username'],'email':user['email'],'nickname':user['display_name'] if user['display_name'] is not None else metadata.get('nickname',''),'uid':user['uid'] or '','avatar':('/api/auth/avatar?revision='+str(user['profile_revision'])) if user['has_avatar'] and scope is None else ('/api/v2/auth/avatar?revision='+str(user['profile_revision'])) if user['has_avatar'] else metadata.get('avatar',''),'role':user['role'] if scope is None else 'user','is_test':user['is_test'],'emailVerified':bool(user['email_verified']),'security':{'twoFactorEnabled':bool(user['totp_enabled'])}}
    if scope is not None:
        from .native_identity_capabilities import email_verification_capable
        scopes=set(scope.split());read='security.read' in scopes;write='security.write' in scopes;profile='profile.write' in scopes
        value['scope']=scope
        value['capabilities']={'twoFactorRead':read,'twoFactorWrite':write,'passkeysRead':read,'passkeysWrite':write,'passkeyRegistration':False,'devicesRead':read,'devicesWrite':write,'emailVerification':email_verification_capable(scope,email_availability),'passwordRecovery':True,'profileWrite':profile,'avatarUpload':profile,'emailWrite':True,'passwordWrite':True,'overviewTotalAssets':False,'feedRead':False,'feedWrite':False,**{s:False for s in ('assets.read','positions.read','cash.read','orders.read','orders.write','orders.cancel')}}
    return value


def discovery(version,config):
    p=f'/api/v{version}'
    security={'version':version,'read_scope':'security.read','write_scope':'security.write','email_verification_path':p+'/auth/email-verification','totp_path':p+'/auth/totp','passkeys_path':p+'/auth/passkeys','devices_path':p+'/auth/security-devices','password_reset_path':p+'/auth/password-reset','password_reset_email_code_ttl_seconds':1800,'passkey_registration':{'supported':False,'rpID':config['rp_id'],'origin':config['origin'],'reason':'web_registration_only'},'account_change':{'version':1,'write_scope':'security.write','proof_ttl_seconds':300,'password':{'verify_path':p+'/auth/password-change/verify','confirm_path':p+'/auth/password-change/confirm','verification':'current_password','requires_totp':False},'email':{'request_path':p+'/auth/email-change/request','verify_path':p+'/auth/email-change/verify','confirm_path':p+'/auth/email-change/confirm','verification':'current_email_code','code_digits':6,'challenge_ttl_seconds':1800,'retry_after_seconds':60,'max_attempts':5,'requires_password':False,'requires_totp':False},'reauthentication_required':True}}
    native={'supported':True,'version':2,'api_version':2,'client_id':CLIENT,'login_path':'/api/v2/auth/login','two_factor_path':'/api/v2/auth/login/totp','permissions_path':'/api/v2/auth/permissions','permissions_authentication':'current_grant','permissions_requires_password':False,'permissions_requires_2fa':False,'scope':BASE_SCOPE,'scopes_supported':sorted(SCOPES),'factors':['totp','backup_code'],'challenge_expires_in':300,'account_consent':{'version':1,'path':'/api/v2/auth/consent','authentication':'current_grant','scope_source':'account_client'},'email_registration':{'supported':False}}
    from .personal_profiles import personal_discovery
    from .resource_contract import discovery as resource_discovery
    return {'resource_library': resource_discovery(p+'/resource-library'), 'personal_profile': personal_discovery(p+'/personal-profile'), 'version':version,'api_versions_supported':[1,2],'app_api_version':2,'app_api_base_path':'/api/v2','client_id':CLIENT,'redirect_uri':REDIRECT,'scope':BASE_SCOPE,'scopes_supported':sorted(SCOPES),'profile_path':p+'/auth/profile','upload_path':p+'/upload','email_path':p+'/auth/email','password_path':p+'/auth/password','feed_path':p+'/feed','authorization_path':'/app/authorize','authorization_submit_path':'/api/v1/auth/authorize','token_path':p+'/auth/token','revoke_path':p+'/auth/revoke','devices_path':'/app/devices','code_challenge_methods_supported':['S256'],'security':security,'native_login':native}


def canonical_native_discovery(value):
    # Canonical auth paths use canonical entry points. The explicitly versioned
    # registration receipt contract retains its reviewed compatibility Web paths.
    native = value['native_login']
    from .resource_contract import discovery as resource_discovery
    result = {
        'resource_library': resource_discovery('/api/client/resource-library'),
        'app_api_base_path': '/api/client',
        'client_id': value['client_id'], 'redirect_uri': value['redirect_uri'],
        'scope': value['scope'], 'scopes_supported': value['scopes_supported'],
        'code_challenge_methods_supported': ['S256'],
        'authorization_submit_path': '/api/client/authorize',
        'token_path': '/api/client/token', 'revoke_path': '/api/client/revoke',
        'profile_read_path': '/api/client/me', 'email_path': '/api/client/email',
        'profile_path': '/api/client/profile', 'upload_path': '/api/client/profile/avatar',
        'personal_profile': {**value['personal_profile'], 'path': '/api/client/personal-profile',
            'background_path': '/api/client/personal-profile/background',
            'operation_path': '/api/client/personal-profile/operations/{requestId}'},
        'native_login': {
            'supported': True, 'client_id': value['client_id'],
            'login_path': '/api/client/login', 'two_factor_path': '/api/client/login/totp',
            'permissions_path': '/api/client/permissions',
            'permissions_authentication': 'current_grant',
            'permissions_requires_password': False, 'permissions_requires_2fa': False,
            'scope': native['scope'], 'scopes_supported': native['scopes_supported'],
            'factors': native['factors'], 'challenge_expires_in': native['challenge_expires_in'],
            'email_registration': native['email_registration'],
            'account_consent': {'path': '/api/client/consent', 'authentication': 'current_grant', 'scope_source': 'account_client'},
        },
        'security': {
            **value['security'],
            'email_verification_path': '/api/client/auth/email-verification',
            'password_reset_path': '/api/client/auth/password-reset',
            'totp_path': '/api/client/auth/totp', 'passkeys_path': '/api/client/auth/passkeys',
            'devices_path': '/api/client/auth/security-devices',
            'account_change': {**value['security']['account_change'],
                'password': {**value['security']['account_change']['password'],
                    'verify_path': '/api/client/auth/password-change/verify',
                    'confirm_path': '/api/client/auth/password-change/confirm'},
                'email': {**value['security']['account_change']['email'],
                    'request_path': '/api/client/email-change/request',
                    'verify_path': '/api/client/email-change/verify',
                    'confirm_path': '/api/client/email-change/confirm'}},
        },
        'email_change': {'request_path': '/api/client/email-change/request',
            'verify_path': '/api/client/email-change/verify', 'confirm_path': '/api/client/email-change/confirm',
            'write_scope': 'security.write', 'proof_ttl_seconds': 300},
        'passkey_registration': {'supported': False, 'reason': 'associated_domain_unverified'},
    }
    if 'market_calendar' in value:
        result['market_calendar'] = {
            **{key: item for key, item in value['market_calendar'].items() if key != 'api_version'},
            'path': '/api/reference/calendar',
            'batch_path': '/api/reference/calendar/batch',
        }
    if 'price_alerts' in value:
        result['price_alerts'] = {**value['price_alerts'], 'snapshot_path': '/api/price-alerts',
            'operation_path': '/api/price-alerts/operations/{request_id}'}
    return result


def mount_legacy_identity(app,settings,db,factors,passkeys,management,rate_limit):
    async def budget(request,category,limit=40):
        address=request.client.host if request.client else 'unknown'
        if not await rate_limit(db,digest(category+':'+address),limit):raise LegacyError(429,42901,'尝试过于频繁，请稍后再试')

    async def password_user(conn,username,password):
        rows=await (await conn.execute("SELECT * FROM users WHERE lower(username)=lower(%s) OR (email<>'' AND lower(email)=lower(%s)) LIMIT 2",(username.strip(),username.strip()))).fetchall()
        row=rows[0] if len(rows)==1 else None
        valid=await asyncio.to_thread(verify_password,password,row['password_hash'] if row else DUMMY_HASH)
        if not row or not valid or not row['active']:raise LegacyError(403,40103,'用户名或密码错误')
        current=await (await conn.execute('SELECT * FROM users WHERE id=%s FOR UPDATE',(row['id'],))).fetchone()
        if current['password_hash']!=row['password_hash'] or not current['active'] or current['session_version']!=row['session_version']:
            raise LegacyError(403,40103,'账号状态已变化，请重新登录')
        return current

    async def create_legacy_session(conn,user,request_id,*,v1=False):
        token=secrets.token_hex(32)
        row=await (await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES(%s,%s,%s,%s,clock_timestamp()+interval '7 days') RETURNING expires_at",(digest(token),user['id'],'legacy-v1' if v1 else 'legacy-web',user['session_version']))).fetchone()
        await conn.execute("DELETE FROM sessions WHERE user_id=%s AND client_id IN ('legacy-web','legacy-v1') AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=%s AND client_id IN ('legacy-web','legacy-v1') ORDER BY created_at DESC,token_hash LIMIT 20)",(user['id'],user['id']))
        return token,row

    async def native_session(conn,user,request_id,context):
        pair=await issue_grant(conn,user,context['scope'],context['device_name'])
        return pair['access_token'],pair

    async def auth_result(conn,user,pair,**extra):
        return {'status':'authenticated','apiVersion':2,**pair,'user':await public_profile(conn,user['id'],scope=pair['scope'],settings=settings),**extra}

    async def native_config_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        async with db.connection() as conn:
            config = await (await conn.execute('SELECT * FROM identity_passkey_config WHERE singleton=true')).fetchone()
        value = discovery(version, config)
        from .native_identity_capabilities import email_verification_availability, native_email_registration_discovery
        async with db.connection() as conn:
            mail_availability = await email_verification_availability(conn, settings)
            value['security']['email_verification_delivery'] = mail_availability
            value['native_login']['email_registration'] = await native_email_registration_discovery(conn, settings, mail_availability)
        value['security']['password_recovery_supported'] = True
        from .price_alert_runtime import discovery as price_alerts_discovery
        value['price_alerts'] = await price_alerts_discovery(app.state.price_alerts, version)
        from .market_calendar import Calendars
        calendar = await Calendars(db).discovery()
        if calendar is not None:
            value['market_calendar'] = calendar
        from .account_sync_api import discovery as account_sync_discovery
        value['account_sync'] = account_sync_discovery()
        return value

    @app.get('/api/v{version}/auth/config', tags=['legacy-native-identity'])
    async def native_config(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_config_operation(version, request, response), request, response)

    @app.get('/api/client/config', tags=['client-identity'])
    async def client_native_config(request: Request, response: Response):
        return canonical_native_discovery(await native_config_operation(2, request, response))

    async def native_login_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        await budget(request, 'native-login', 50)
        data = await body(request, ('client_id', 'username', 'password', 'device_name') if version == 2 else ('username', 'password'))
        username, password = (data.get('username'), data.get('password'))
        if not isinstance(username, str) or not isinstance(password, str) or (not 1 <= len(username) <= 254) or (not 1 <= len(password.encode('utf-16-le')) // 2 <= 128):
            raise LegacyError(403, 40103, '用户名或密码错误')
        if version == 2 and data.get('client_id') != CLIENT:
            raise LegacyError(400, 40002, '请求参数无效')
        device = data.get('device_name', 'Alcor iOS')
        if not isinstance(device, str) or len(device.encode('utf-16-le')) // 2 > 64 or any((ord(c) < 32 or ord(c) == 127 for c in device)):
            raise LegacyError(400, 40002, '设备名称无效')
        if not await rate_limit(db, digest('native-login-account:' + username.strip().lower()), 20):
            raise LegacyError(429, 42901, '尝试过于频繁，请稍后再试')
        async with db.connection() as conn, conn.transaction():
            user = await password_user(conn, username, password)
            context = {'scope': BASE_SCOPE, 'device_name': device.strip() or 'Alcor iOS', 'api_version': version}
            challenge = await factors.challenge_password(conn, user, response, legacy=version == 1, native_context=context)
            if challenge:
                if version == 1:
                    return {'requires2fa': True, 'ticket': challenge['challenge_token']}
                return {**challenge, 'apiVersion': 2, 'purpose': 'login'}
            if version == 1:
                token, _ = await create_legacy_session(conn, user, request.state.request_id, v1=True)
                return {'user': {'id': user['id'], 'username': user['username']}, 'token': token, 'expiresIn': 604800}
            pair = await issue_grant(conn, user, BASE_SCOPE, context['device_name'])
            return await auth_result(conn, user, pair)

    @app.post('/api/v{version}/auth/login', tags=['legacy-native-identity'])
    async def native_login(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_login_operation(version, request, response), request, response)

    @app.post('/api/client/login', tags=['client-identity'])
    async def client_native_login(request: Request, response: Response):
        return await native_login_operation(2, request, response)

    async def native_totp_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        await budget(request, 'native-totp')
        data = await body(request, ('client_id', 'challenge_token', 'code') if version == 2 else ('ticket', 'code'))
        token = data.get('challenge_token' if version == 2 else 'ticket', '')
        code = data.get('code', '')
        if not isinstance(token, str) or not isinstance(code, str) or (not 6 <= len(code) <= 32) or (version == 2 and data.get('client_id') != CLIENT):
            raise LegacyError(400, 40002, '请求参数无效')
        async with db.connection() as conn:
            pending = await (await conn.execute("SELECT payload FROM identity_challenges WHERE id=%s AND purpose='password-login'", (digest(token),))).fetchone()
        if not pending or 'native' not in pending['payload']:
            raise LegacyError(403, 40105, '验证已失效，请重新开始')
        context = pending['payload']['native']
        if context.get('api_version') != version or not re.fullmatch('flc_[A-Za-z0-9_-]{43}' if version == 2 else '[a-f0-9]{48}', token):
            raise LegacyError(403, 40105, '验证已失效，请重新开始')

        async def make(conn, user, rid):
            return await create_legacy_session(conn, user, rid, v1=True) if version == 1 else await native_session(conn, user, rid, context)
        try:
            user, access, pair = await factors.finish_password(token, code, token, request.state.request_id, make)
        except HTTPException:
            raise LegacyError(403 if version == 2 else 401, 40104, '验证码或备用码不正确，或验证已失效') from None
        if version == 1:
            return {'user': {'id': user['id'], 'username': user['username']}, 'token': access, 'expiresIn': 604800}
        async with db.connection() as conn:
            return await auth_result(conn, user, pair)

    @app.post('/api/v{version}/auth/login/totp', tags=['legacy-native-identity'])
    async def native_totp(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_totp_operation(version, request, response), request, response)

    @app.post('/api/client/login/totp', tags=['client-identity'])
    async def client_native_totp(request: Request, response: Response):
        return await native_totp_operation(2, request, response)

    async def native_me_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        authorization = request.headers.get('authorization', '')
        if version == 1 and (not authorization.startswith('Bearer fat_')):
            who, user, token = await web_identity(request, db, allow_v1_bearer=True)
            async with db.connection() as conn, conn.transaction():
                from .security import lock_mutation_identity
                await lock_mutation_identity(conn, who, require_admin=False)
                value = await public_profile(conn, who.id)
        else:
            who, grant = await native_identity(request, db)
            async with db.connection() as conn, conn.transaction():
                from .security import lock_mutation_identity
                await lock_mutation_identity(conn, who, require_admin=False)
                value = await public_profile(conn, who.id, scope=grant['scope'], settings=settings)
        return value

    @app.get('/api/v{version}/auth/me', tags=['legacy-native-identity'])
    async def native_me(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_me_operation(version, request, response), request, response)

    @app.get('/api/client/me', tags=['client-identity'])
    async def client_native_me(request: Request, response: Response):
        return await native_me_operation(2, request, response)

    async def native_token_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        await budget(request, 'native-token', 60)
        if request.headers.get('content-type', '').startswith('application/x-www-form-urlencoded'):
            raw = await request.body()
            if len(raw) > 8192:
                raise LegacyError(400, 40002, '无效的令牌请求')
            parsed = parse_qs(raw.decode())
            data = {k: v[0] for k, v in parsed.items() if len(v) == 1}
        else:
            data = await body(request, ('grant_type', 'client_id', 'refresh_token', 'redirect_uri', 'code', 'code_verifier'), 8192)
        async with db.connection() as conn, conn.transaction():
            if data.get('grant_type') == 'refresh_token':
                result = await rotate(conn, data.get('client_id', ''), data.get('refresh_token', ''))
            elif data.get('grant_type') == 'authorization_code':
                if data.get('client_id') != CLIENT or data.get('redirect_uri') != REDIRECT or (not re.fullmatch('fac_[A-Za-z0-9_-]{43}', data.get('code', ''))) or (not re.fullmatch('[A-Za-z0-9._~-]{43,128}', data.get('code_verifier', ''))):
                    raise LegacyError(400, 40002, '无效的令牌请求')
                pending = await (await conn.execute("SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='app-code' FOR UPDATE", (digest(data['code']),))).fetchone()
                challenge = base64.urlsafe_b64encode(hashlib.sha256(data['code_verifier'].encode()).digest()).decode().rstrip('=')
                result = None
                if pending and pending['valid'] and hmac.compare_digest(challenge, pending['payload']['code_challenge']):
                    await conn.execute('DELETE FROM identity_challenges WHERE id=%s', (digest(data['code']),))
                    session = await (await conn.execute('SELECT s.passkey_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=%s AND s.user_id=%s AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version AND u.active FOR UPDATE OF u', (pending['binding'], pending['user_id']))).fetchone()
                    if session:
                        result = await issue_grant(conn, session, pending['payload']['scope'], pending['payload']['device_name'], session['passkey_id'])
                        await remember_consent(conn, session, result['scope'])
            else:
                raise LegacyError(400, 40002, '无效的令牌请求')
        if not result:
            raise LegacyError(401, 40102, '连接凭据无效或已使用')
        return result

    @app.post('/api/v{version}/auth/token', tags=['legacy-native-identity'])
    async def native_token(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_token_operation(version, request, response), request, response)

    @app.post('/api/client/token', tags=['client-identity'])
    async def client_native_token(request: Request, response: Response):
        return await native_token_operation(2, request, response)

    async def native_revoke_operation(version: int, request: Request, response: Response):
        assert_native_origin(request, settings)
        await budget(request, 'native-revoke', 60)
        data = await body(request, ('client_id', 'token'), 8192)
        token = data.get('token', '')
        if data.get('client_id') != CLIENT or not isinstance(token, str) or (not re.fullmatch('(fat|frt)_[A-Za-z0-9_-]{43}', token)):
            raise LegacyError(400, 40001, '无效的连接凭据')
        from .native_app_auth import revoke_presented_token
        async with db.connection() as conn,conn.transaction():
            await revoke_presented_token(conn,token,request.state.request_id)
        return {'revoked': True}

    @app.post('/api/v{version}/auth/revoke', tags=['legacy-native-identity'])
    async def native_revoke(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await native_revoke_operation(version, request, response), request, response)

    @app.post('/api/client/revoke', tags=['client-identity'])
    async def client_native_revoke(request: Request, response: Response):
        return await native_revoke_operation(2, request, response)

    async def native_permissions_operation(request: Request, response: Response):
        assert_native_origin(request, settings)
        await budget(request, 'native-permissions', 50)
        data = await body(request, ('client_id', 'scope', 'currentPassword'))
        if data.get('client_id') != CLIENT or not isinstance(data.get('scope'), str) or (not data['scope'].strip()):
            raise LegacyError(400, 40002, '请求参数无效')
        token = request.headers.get('authorization', '').removeprefix('Bearer ')
        async with db.connection() as conn, conn.transaction():
            grant = await authenticate(conn, token, lock=True)
            requested = ' '.join(dict.fromkeys(grant['scope'].split() + data['scope'].split()))
            requested = parse_scopes(requested)
            user = {**grant, 'id': grant['user_id'], 'session_version': grant['current_version']}
            pair = await issue_grant(conn, user, requested, grant['device_name'], preserve_grant_id=grant['id'])
            await remember_consent(conn, user, pair['scope'])
            return await auth_result(conn, user, pair, replaces_grant_id=grant['id'])

    @app.post('/api/v2/auth/permissions', tags=['legacy-native-identity'])
    async def native_permissions(request: Request, response: Response):
        native_version(request)
        return envelope(await native_permissions_operation(request, response), request, response)

    @app.post('/api/client/permissions', tags=['client-identity'])
    async def client_native_permissions(request: Request, response: Response):
        return await native_permissions_operation(request, response)

    async def native_consent_operation(request: Request, response: Response):
        assert_native_origin(request, settings)
        data = await body(request, ('client_id', 'revision')) if request.method == 'POST' else None
        if data is not None and data.get('client_id') != CLIENT:
            raise LegacyError(400, 40002, '请求参数无效')
        token = request.headers.get('authorization', '').removeprefix('Bearer ')
        async with db.connection() as conn, conn.transaction():
            grant = await authenticate(conn, token, lock=True)
            user = {**grant, 'id': grant['user_id'], 'session_version': grant['current_version']}
            consent = await consent_descriptor(conn, user)
            descriptor = {'apiVersion': 2, 'version': 1, 'client_id': CLIENT, 'user_id': user['id'], 'grant_id': grant['id'], **consent}
            if data is None:
                return descriptor
            if data.get('revision') != consent['revision']:
                raise LegacyError(409, 40901, '授权已变化，请重新核对')
            scope = parse_scopes(' '.join(dict.fromkeys(grant['scope'].split() + consent['scope'].split())))
            if set(scope.split()) == set(grant['scope'].split()):
                return {'status': 'unchanged', **descriptor}
            pair = await issue_grant(conn, user, scope, grant['device_name'], preserve_grant_id=grant['id'])
            return await auth_result(conn, user, pair, replaces_grant_id=grant['id'])

    @app.get('/api/v2/auth/consent', tags=['legacy-native-identity'])
    @app.post('/api/v2/auth/consent', tags=['legacy-native-identity'])
    async def native_consent(request: Request, response: Response):
        native_version(request)
        return envelope(await native_consent_operation(request, response), request, response)

    @app.get('/api/client/consent', tags=['client-identity'])
    @app.post('/api/client/consent', tags=['client-identity'])
    async def client_native_consent(request: Request, response: Response):
        return await native_consent_operation(request, response)

    async def authorize_app_operation(request: Request, response: Response):
        assert_native_origin(request, settings)
        trusted_origin(request)
        if request.headers.get('authorization'):
            raise LegacyError(403, 40301, '请在 Alcor 网页确认连接')
        who, user, token = await web_identity(request, db, allow_platform=True)
        await budget(request, 'native-authorize', 20)
        data = await body(request, ('client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'device_name', 'decision'), 8192)
        if data.get('decision') not in ('allow', 'deny') or data.get('client_id') != CLIENT or data.get('redirect_uri') != REDIRECT or (data.get('response_type') != 'code') or (data.get('code_challenge_method') != 'S256'):
            raise LegacyError(400, 40001, '不支持的 App 或回调地址')
        state = data.get('state', '')
        challenge = data.get('code_challenge', '')
        device = data.get('device_name', 'Alcor iOS')
        if not isinstance(state, str) or not re.fullmatch('[A-Za-z0-9_-]{32,128}', state) or (not isinstance(challenge, str)) or (not re.fullmatch('[A-Za-z0-9_-]{43}', challenge)):
            raise LegacyError(400, 40001, '无效的授权校验参数')
        if not isinstance(device, str) or len(device.encode('utf-16-le')) // 2 > 64 or any((ord(c) < 32 for c in device)):
            raise LegacyError(400, 40001, '设备名称无效')
        scope = parse_scopes(data.get('scope', ''))
        callback = {'state': state}
        if data['decision'] == 'deny':
            callback['error'] = 'access_denied'
        else:
            async with db.connection() as conn, conn.transaction():
                from .security import lock_mutation_identity
                await lock_mutation_identity(conn, who, require_admin=False)
                code = opaque('fac_')
                await conn.execute("INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'app-code',%s,%s,%s,clock_timestamp()+interval '1 minute')", (digest(code), who.id, digest(token), Jsonb({'scope': scope, 'device_name': device.strip() or 'Alcor iOS', 'code_challenge': challenge})))
                await conn.execute("INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.app.authorized')", (who.id,))
            callback['code'] = code
        return {'callback': REDIRECT + '?' + urlencode(callback)}

    @app.post('/api/v1/auth/authorize', tags=['legacy-native-identity'])
    async def authorize_app(request: Request, response: Response):
        native_version(request)
        return envelope(await authorize_app_operation(request, response), request, response)

    @app.post('/api/client/authorize', tags=['client-identity'])
    async def client_authorize_app(request: Request, response: Response):
        return await authorize_app_operation(request, response)

    @app.get('/api/auth/setup-status', tags=['legacy-web-identity'])
    async def web_setup_status():
        from .accounts import registration_status
        async with db.connection() as conn:
            status = await registration_status(conn)
        return {'needsSetup': status['first_user']}

    @app.get('/api/v1/auth/setup-status', tags=['legacy-native-identity'])
    async def native_setup_status(request:Request,response:Response):
        return envelope(await web_setup_status(),request,response)

    @app.post('/api/auth/register', status_code=201, tags=['legacy-web-identity'])
    async def web_register(request: Request, response: Response):
        from .registration import register_account
        trusted_origin(request)
        data = await body(request, ('username', 'password', 'setupToken', 'isTest'))
        username, password = data.get('username'), data.get('password')
        if (not isinstance(username, str) or not isinstance(password, str)
                or (data.get('setupToken') is not None and (
                    not isinstance(data['setupToken'], str) or len(data['setupToken']) > 512))
                or ('isTest' in data and not isinstance(data['isTest'], bool))):
            raise LegacyError(400, 40002, '请求参数无效')
        # Test identities have their own authority and must never become ordinary platform users.
        if data.get('isTest'):
            raise LegacyError(403, 40301, '测试账号请使用独立隔离环境')
        username = username.strip()
        if not re.fullmatch(r'[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}', username) or not 1 <= len(password) <= 128:
            raise LegacyError(400, 40001, '用户名或密码格式不正确')
        user, token, _ = await register_account(
            db, rate_limit, request.client.host if request.client else 'unknown',
            username, password, request.state.request_id, create_legacy_session, setup_token=data.get('setupToken'),
        )
        async with db.connection() as conn:
            value = await public_profile(conn, user['id'])
        response.set_cookie(WEB_COOKIE, token, httponly=True, secure=settings.secure_cookie,
                            samesite='lax', max_age=604800, path='/')
        return {'user': value}

    @app.post('/api/auth/login',tags=['legacy-web-identity'])
    async def web_login(request:Request,response:Response):
        trusted_origin(request);await budget(request,'legacy-web-login',50)
        data=await body(request,('username','password'));username,password=data.get('username'),data.get('password')
        if not isinstance(username,str) or not isinstance(password,str) or not 1<=len(username)<=254 or not 1<=len(password)<=128:raise LegacyError(401,40103,'用户名或密码错误')
        if not await rate_limit(db,digest('legacy-web-account:'+username.strip().lower()),20):raise LegacyError(429,42901,'尝试过于频繁，请稍后再试')
        async with db.connection() as conn,conn.transaction():
            try:user=await password_user(conn,username,password)
            except HTTPException:raise LegacyError(401,40103,'用户名或密码错误') from None
            challenge=await factors.challenge_password(conn,user,response,legacy=True)
            if challenge:return {'requires2fa':True,'ticket':challenge['challenge_token']}
            token,_=await create_legacy_session(conn,user,request.state.request_id)
        response.set_cookie(WEB_COOKIE,token,httponly=True,secure=settings.secure_cookie,samesite='lax',max_age=604800,path='/')
        return {'user':{'id':user['id'],'username':user['username']},'expiresIn':604800}

    @app.post('/api/auth/login/totp',tags=['legacy-web-identity'])
    async def web_totp(request:Request,response:Response):
        trusted_origin(request);await budget(request,'legacy-web-totp')
        data=await body(request,('ticket','code'));ticket,code=data.get('ticket',''),data.get('code','')
        if not isinstance(ticket,str) or not re.fullmatch(r'[a-f0-9]{48}',ticket) or not isinstance(code,str) or not 6<=len(code)<=32:raise LegacyError(400,40002,'请求参数无效')
        try:
            user,token,_=await factors.finish_password(ticket,code,request.cookies.get(FACTOR_COOKIE,''),request.state.request_id,create_legacy_session)
        except HTTPException as exc:
            if exc.status_code==403:raise LegacyError(401,40104,'验证码或备用码不正确，或验证已失效') from None
            raise
        response.delete_cookie(FACTOR_COOKIE,path='/')
        response.set_cookie(WEB_COOKIE,token,httponly=True,secure=settings.secure_cookie,samesite='lax',max_age=604800,path='/')
        return {'user':{'id':user['id'],'username':user['username']},'expiresIn':604800}

    @app.get('/api/auth/me',tags=['legacy-web-identity'])
    @app.post('/api/auth/me',tags=['legacy-web-identity'])
    async def web_me(request:Request,response:Response):
        posting=request.method=='POST'
        if posting and not legacy_me_mutation_trusted(request):
            return JSONResponse({'error':'请求来源不受信任'},status_code=403,headers={'Cache-Control':'no-store'})
        try:
            who,_user,token=await web_identity(request,db,allow_legacy_bearer=posting,origin_checked=posting)
        except HTTPException as exc:
            if posting and exc.status_code==401:
                return JSONResponse({'error':'未登录'},status_code=401,headers={'Cache-Control':'no-store'})
            raise
        response.headers['Cache-Control']='private, no-store'
        response.headers['Vary']='Cookie, Authorization'
        async with db.connection() as conn, conn.transaction():
            from .security import lock_mutation_identity
            needs_renewal=False
            if posting and 'authorization' not in request.headers:
                expiry=await(await conn.execute("SELECT expires_at<=clock_timestamp()+interval '6 days' AS due FROM sessions WHERE token_hash=%s AND client_id='legacy-web'",(digest(token),))).fetchone()
                needs_renewal=bool(expiry and expiry['due'])
            if needs_renewal:
                # Serialize renewals before taking the session read lock; two
                # concurrent renewals must not upgrade shared locks together.
                # A fresh session only needs shared reads and must not block
                # navigation behind a migration's authorized domain commit.
                await conn.execute('SELECT id FROM users WHERE id=%s FOR UPDATE',(who.id,))
            await lock_mutation_identity(conn,who,require_admin=False)
            value=await public_profile(conn,who.id)
            # Bearer is explicit and must not extend or rewrite the browser cookie.
            if needs_renewal:
                renewed=await (await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()+interval '7 days' WHERE token_hash=%s AND client_id='legacy-web' AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '6 days' RETURNING expires_at",(digest(token),))).fetchone()
                if renewed:
                    response.set_cookie(WEB_COOKIE,token,httponly=True,secure=settings.secure_cookie,samesite='lax',max_age=604800,path='/')
                    response.delete_cookie(OLD_COOKIE,path='/',httponly=True,samesite='lax',secure=False)
        return {'user':value}

    async def revoke_legacy_session(conn,token,clients,request_id):
        if not token or len(token)>128:return
        found=await(await conn.execute('SELECT user_id FROM sessions WHERE token_hash=%s AND client_id=ANY(%s)',(digest(token),clients))).fetchone()
        if not found:return
        from psycopg.errors import LockNotAvailable
        try:
            await conn.execute('SELECT id FROM users WHERE id=%s FOR NO KEY UPDATE NOWAIT',(found['user_id'],))
            await conn.execute('SELECT token_hash FROM sessions WHERE token_hash=%s AND client_id=ANY(%s) FOR UPDATE NOWAIT',(digest(token),clients))
        except LockNotAvailable:
            raise LegacyError(503,50301,'会话状态正在变化，请核对后重试') from None
        row=await(await conn.execute('DELETE FROM sessions WHERE token_hash=%s AND client_id=ANY(%s) RETURNING user_id',(digest(token),clients))).fetchone()
        if row:
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'session.revoked',%s)",(row['user_id'],request_id))

    @app.post('/api/auth/logout',tags=['legacy-web-identity'])
    async def web_logout(request:Request,response:Response):
        trusted_origin(request)
        token=request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
        async with db.connection() as conn,conn.transaction():
            await revoke_legacy_session(conn,token,['legacy-web'],request.state.request_id)
        response.delete_cookie(WEB_COOKIE,path='/');response.delete_cookie(OLD_COOKIE,path='/')
        return {'ok':True}

    @app.post('/api/v1/auth/logout',tags=['legacy-native-identity'])
    async def native_v1_logout(request:Request,response:Response):
        authorization=request.headers.get('authorization','')
        bearer=authorization[7:].strip() if authorization.startswith('Bearer ') else ''
        if not bearer:trusted_origin(request)
        await budget(request,'native-logout',60)
        token=bearer or request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
        async with db.connection() as conn,conn.transaction():
            if bearer and bearer.startswith(('fat_','frt_')):
                from .native_app_auth import revoke_presented_token
                await revoke_presented_token(conn,bearer,request.state.request_id)
            else:
                await revoke_legacy_session(conn,token,['legacy-v1','legacy-web'] if bearer else ['legacy-web'],request.state.request_id)
        response.delete_cookie(WEB_COOKIE,path='/');response.delete_cookie(OLD_COOKIE,path='/')
        return envelope({'loggedOut':True},request,response)

    from .legacy_totp import mount_legacy_totp
    mount_legacy_totp(app,settings,db,management,rate_limit,lambda request:web_identity(request,db),body)
    from .legacy_passkeys import mount_legacy_passkeys
    mount_legacy_passkeys(app,settings,db,factors,rate_limit,lambda request:web_identity(request,db),body,create_legacy_session)
    from .legacy_identity_security import mount_legacy_identity_security
    mount_legacy_identity_security(app,settings,db,rate_limit,lambda request:web_identity(request,db),body)
    from .legacy_devices import mount_legacy_devices
    mount_legacy_devices(app,settings,db,rate_limit)
    from .legacy_native_security import mount_legacy_native_security
    mount_legacy_native_security(app,settings,db,rate_limit)

    app.state.legacy_create_session=create_legacy_session
    app.state.legacy_web_identity=lambda request:web_identity(request,db)
    from .legacy_identity_email import mount_legacy_identity_email
    mount_legacy_identity_email(app,settings,db,rate_limit)

    from .legacy_identity_recovery import mount_legacy_identity_recovery
    mount_legacy_identity_recovery(app,settings,db,rate_limit)

    from .legacy_identity_email_change import mount_legacy_identity_email_change
    mount_legacy_identity_email_change(app,settings,db,rate_limit)
