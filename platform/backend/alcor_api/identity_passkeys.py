"""Shared native WebAuthn ceremonies with independent Web protocol bindings."""
import asyncio
import base64
import json
import secrets

from fastapi import HTTPException
from psycopg.types.json import Jsonb
from webauthn import (
    base64url_to_bytes, generate_authentication_options, generate_registration_options,
    options_to_json, verify_authentication_response, verify_registration_response,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)
from .passwords import verify_password
from .security import digest, lock_mutation_identity

PASSKEY_COOKIE = 'alcor_passkey_challenge'
ALGORITHMS = [COSEAlgorithmIdentifier.ECDSA_SHA_256, COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256]


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def top_level(credential):
    try:
        data = json.loads(base64url_to_bytes(credential['response']['clientDataJSON']))
        if data.get('crossOrigin') or data.get('topOrigin'):
            raise ValueError()
    except Exception:
        raise HTTPException(400, '请直接打开站点完成通行密钥验证') from None


class Passkeys:
    def __init__(self, settings, db, factors, *, client_id='new-web', cookie_name=PASSKEY_COOKIE, cookie_path='/'):
        if client_id not in {'new-web', 'legacy-web'}:
            raise ValueError('Unsupported Web passkey protocol')
        self.settings, self.db, self.factors = settings, db, factors
        self.client_id, self.cookie_name, self.cookie_path = client_id, cookie_name, cookie_path

    async def serialize(self, conn, who):
        # Every factor management flow takes this before user/session row locks.
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))

    async def config(self, conn, request):
        # Hold the verified configuration through commit, before any identity locks.
        c = await (await conn.execute('SELECT * FROM identity_passkey_config WHERE singleton=true FOR SHARE')).fetchone()
        if not c or not c['enabled']:
            raise HTTPException(409, '站点尚未启用通行密钥')
        if c['origin'] != self.settings.public_origin or request.headers.get('origin') != c['origin']:
            raise HTTPException(403, '请通过通行密钥绑定的站点地址登录')
        return c

    async def step_up(self, conn, who, password, code):
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s FOR UPDATE', (who.id,))).fetchone()
        from .session_verification import SESSION_PROOF, verified
        if password == SESSION_PROOF:
            if user and await verified(conn, who):
                return user
            raise HTTPException(403, '验证已失效，请重新使用通行密钥验证')
        if not user or not await asyncio.to_thread(verify_password, password, user['password_hash']):
            raise HTTPException(403, '当前密码不正确')
        factor = await self.factors.factor(conn, who.id)
        if factor and factor['totp_enabled'] and not await self.factors.consume(conn, who.id, code):
            raise HTTPException(403, '二次验证码或备用码不正确')
        return user

    async def verify_options(self, request, response, who):
        async with self.db.connection() as conn, conn.transaction():
            c = await self.config(conn, request)
            await self.serialize(conn, who)
            await lock_mutation_identity(conn, who, require_admin=False)
            keys = await (await conn.execute('SELECT id FROM identity_passkeys WHERE user_id=%s AND rp_id=%s ORDER BY id LIMIT 21', (who.id,c['rp_id']))).fetchall()
            if not keys or len(keys)>20:raise HTTPException(409, '当前账号没有可用的通行密钥')
            options = generate_authentication_options(rp_id=c['rp_id'], allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(k['id'])) for k in keys], user_verification=UserVerificationRequirement.REQUIRED)
            value=json.loads(options_to_json(options))
            request_id=await self.issue(conn,c,'verify',{'challenge':value['challenge']},response,who)
            return {'options':value,'requestId':request_id}

    async def verify_session(self, data, request, response, who):
        failure=None
        async with self.db.connection() as conn, conn.transaction():
            try:
                c=await self.config(conn,request)
                await self.serialize(conn,who)
                await lock_mutation_identity(conn,who,require_admin=False)
                pending=await self.take(conn,c,'verify',data.requestId,request,who)
                async with conn.transaction():
                    credential=data.response;top_level(credential)
                    key=await(await conn.execute('SELECT * FROM identity_passkeys WHERE id=%s AND user_id=%s AND rp_id=%s FOR UPDATE',(credential.get('id',''),who.id,c['rp_id']))).fetchone()
                    if not key or credential.get('response',{}).get('userHandle') not in (None,'',key['user_handle']):raise HTTPException(403,'通行密钥验证失败')
                    result=verify_authentication_response(credential=credential,expected_challenge=base64url_to_bytes(pending['challenge']),expected_rp_id=c['rp_id'],expected_origin=c['origin'],credential_public_key=key['public_key'],credential_current_sign_count=key['counter'],require_user_verification=True)
                    await conn.execute('UPDATE identity_passkeys SET counter=%s,last_used_at=clock_timestamp(),backed_up=%s WHERE id=%s',(result.new_sign_count,result.credential_backed_up,key['id']))
                    await conn.execute("UPDATE sessions SET auth_method='passkey',passkey_id=%s WHERE token_hash=%s AND user_id=%s",(key['id'],who.token_hash,who.id))
                    await conn.execute("INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.session.verified')",(who.id,))
            except HTTPException as exc:failure=exc
            except Exception:failure=HTTPException(403,'通行密钥验证失败，请重新尝试')
        if failure:raise failure
        response.delete_cookie(self.cookie_name,path=self.cookie_path)
        return {'ok':True}

    def purpose(self, purpose):
        return 'passkey-' + self.client_id + '-' + purpose

    def binding(self, nonce, origin, who=None):
        return digest(self.client_id + ':' + nonce + ':' + origin + ':' + (who.token_hash if who else ''))

    async def issue(self, conn, c, purpose, payload, response, who=None, *, nonce=None):
        token = secrets.token_urlsafe(24)
        supplied_nonce = nonce is not None
        nonce = nonce if supplied_nonce else secrets.token_urlsafe(32)
        binding = self.binding(nonce, c['origin'], who)
        # Nonblocking bounded housekeeping avoids locking another user's ceremony.
        await conn.execute("DELETE FROM identity_challenges WHERE id IN (SELECT id FROM identity_challenges WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)")
        if supplied_nonce and purpose == 'login':
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('passkey-login:' + self.client_id + ':' + binding,))
            await conn.execute('DELETE FROM identity_challenges WHERE purpose=%s AND binding=%s', (self.purpose(purpose), binding))
        payload = {**payload, 'config_revision': c['revision'], 'client_id': self.client_id}
        await conn.execute(
            "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,%s,%s,%s,%s,clock_timestamp()+interval '5 minutes')",
            (digest(token), self.purpose(purpose), who.id if who else None, binding, Jsonb(payload)),
        )
        response.set_cookie(self.cookie_name, nonce, httponly=True, secure=self.settings.secure_cookie, samesite='strict', max_age=300, path=self.cookie_path)
        return token

    async def take(self, conn, c, purpose, request_id, request, who=None):
        binding = self.binding(request.cookies.get(self.cookie_name, ''), c['origin'], who)
        row = await (await conn.execute(
            'DELETE FROM identity_challenges WHERE id=%s AND purpose=%s AND binding=%s AND expires_at>clock_timestamp() RETURNING *',
            (digest(request_id), self.purpose(purpose), binding),
        )).fetchone()
        if (not row or row['payload'].get('config_revision') != c['revision']
                or row['payload'].get('client_id') != self.client_id or (who and row['user_id'] != who.id)):
            raise HTTPException(403, '验证已过期或已使用，请重新尝试')
        return row['payload']

    async def login_options(self, request, response, *, browser_nonce=None):
        async with self.db.connection() as conn, conn.transaction():
            c = await self.config(conn, request)
            options = generate_authentication_options(rp_id=c['rp_id'], user_verification=UserVerificationRequirement.REQUIRED)
            payload = json.loads(options_to_json(options))
            token = await self.issue(conn, c, 'login', {'challenge': payload['challenge']}, response, nonce=browser_nonce)
            return {'options': payload, 'requestId': token}

    async def login_verify(self, data, request, response, create_session):
        result, failure = None, None
        async with self.db.connection() as conn, conn.transaction():
            try:
                c = await self.config(conn, request)
                credential = data.response
                credential_id = credential.get('id', '')
                if not isinstance(credential_id, str):
                    credential_id = ''
                candidate = await (await conn.execute('SELECT user_id FROM identity_passkeys WHERE id=%s AND rp_id=%s', (credential_id, c['rp_id']))).fetchone()
                # Management locks the owner before removing a key. Login must never
                # hold a challenge/key while waiting for that same user row.
                user = await (await conn.execute('SELECT * FROM users WHERE id=%s FOR UPDATE', (candidate['user_id'],))).fetchone() if candidate else None
                pending = await self.take(conn, c, 'login', data.requestId, request)
                # Consume rejected proofs, but roll back counters/sessions together if
                # any verification or later login effect fails.
                async with conn.transaction():
                    top_level(credential)
                    key = await (await conn.execute('SELECT * FROM identity_passkeys WHERE id=%s AND rp_id=%s FOR UPDATE', (credential_id, c['rp_id']))).fetchone()
                    if (not user or not user['active'] or not key or key['user_id'] != user['id']
                            or credential.get('response', {}).get('userHandle') != key['user_handle']):
                        raise HTTPException(403, '通行密钥验证失败')
                    verification = verify_authentication_response(
                        credential=credential, expected_challenge=base64url_to_bytes(pending['challenge']),
                        expected_rp_id=c['rp_id'], expected_origin=c['origin'], credential_public_key=key['public_key'],
                        credential_current_sign_count=key['counter'], require_user_verification=True,
                    )
                    await conn.execute('UPDATE identity_passkeys SET counter=%s,last_used_at=clock_timestamp(),backed_up=%s WHERE id=%s', (verification.new_sign_count, verification.credential_backed_up, key['id']))
                    token, session = await create_session(conn, user, request.state.request_id)
                    await conn.execute("UPDATE sessions SET auth_method='passkey',passkey_id=%s WHERE token_hash=%s", (key['id'], digest(token)))
                    result = (user, token, session)
            except HTTPException as exc:
                failure = exc
            except Exception:
                failure = HTTPException(403, '通行密钥验证失败，请重新尝试')
        if failure:
            raise failure
        response.delete_cookie(self.cookie_name, path=self.cookie_path)
        return result

    async def register_options(self, data, request, response, who):
        async with self.db.connection() as conn, conn.transaction():
            c = await self.config(conn, request)
            await self.serialize(conn, who)
            user = await self.step_up(conn, who, data.password, data.code)
            keys = await (await conn.execute('SELECT * FROM identity_passkeys WHERE user_id=%s', (who.id,))).fetchall()
            if len(keys) >= 20:
                raise HTTPException(409, '最多添加20个通行密钥')
            handle = next((key['user_handle'] for key in keys if key['rp_id'] == c['rp_id']), b64(secrets.token_bytes(32)))
            options = generate_registration_options(
                rp_id=c['rp_id'], rp_name=c['name'], user_name=user['username'], user_id=base64url_to_bytes(handle),
                supported_pub_key_algs=ALGORITHMS,
                authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.REQUIRED, user_verification=UserVerificationRequirement.REQUIRED),
                exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key['id'])) for key in keys if key['rp_id'] == c['rp_id']],
            )
            payload = json.loads(options_to_json(options))
            payload['extensions'] = {'credProps': True}
            token = await self.issue(conn, c, 'register', {
                'challenge': payload['challenge'], 'handle': handle,
                'password_stamp': digest(user['password_hash']), 'session_version': user['session_version'],
            }, response, who)
            return {'options': payload, 'requestId': token}

    async def register_verify(self, data, request, who):
        failure = None
        async with self.db.connection() as conn, conn.transaction():
            try:
                c = await self.config(conn, request)
                await self.serialize(conn, who)
                await lock_mutation_identity(conn, who, require_admin=False)
                user = await (await conn.execute('SELECT * FROM users WHERE id=%s FOR UPDATE', (who.id,))).fetchone()
                pending = await self.take(conn, c, 'register', data.requestId, request, who)
                async with conn.transaction():
                    if digest(user['password_hash']) != pending['password_stamp'] or user['session_version'] != pending['session_version']:
                        raise HTTPException(403, '账号状态已变化，请重新绑定')
                    top_level(data.response)
                    if data.response.get('clientExtensionResults', {}).get('credProps', {}).get('rk') is False:
                        raise HTTPException(400, '请选择支持保存通行密钥的设备')
                    verified = verify_registration_response(
                        credential=data.response, expected_challenge=base64url_to_bytes(pending['challenge']),
                        expected_rp_id=c['rp_id'], expected_origin=c['origin'], require_user_verification=True,
                        supported_pub_key_algs=ALGORITHMS,
                    )
                    count = await (await conn.execute('SELECT count(*) AS n FROM identity_passkeys WHERE user_id=%s', (who.id,))).fetchone()
                    if count['n'] >= 20:
                        raise HTTPException(409, '通行密钥数量已达上限')
                    await conn.execute(
                        'INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                        (b64(verified.credential_id), who.id, pending['handle'], c['rp_id'], verified.credential_public_key, verified.sign_count, Jsonb(data.response.get('response', {}).get('transports', [])), data.name, verified.credential_backed_up),
                    )
                    await conn.execute("INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.passkey.added')", (who.id,))
            except HTTPException as exc:
                failure = exc
            except Exception:
                failure = HTTPException(400, '通行密钥绑定失败，请重新尝试')
        if failure:
            raise failure
        return {'ok': True}
