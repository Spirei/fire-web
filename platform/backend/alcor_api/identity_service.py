"""Platform-native identity factors. Database transactions own factor consumption."""
import hashlib
import hmac
import secrets
from psycopg.types.json import Jsonb
from fastapi import HTTPException
from .connections import Vault
from .native_identity import verify_totp, consume_backup
from .security import digest

FACTOR_COOKIE='alcor_factor_challenge'


class IdentityService:
    def __init__(self,settings,db):
        self.settings,self.db=settings,db
        self.vault=Vault(settings.connection_secret_dir)

    async def factor(self,conn,user_id):
        return await (await conn.execute('SELECT * FROM identity_security WHERE user_id=%s FOR UPDATE',(user_id,))).fetchone()

    def factor_stamp(self,user,factor):
        return digest(f'{user["password_hash"]}:{user["session_version"]}:{factor["totp_enabled"]}:{factor["totp_secret_ciphertext"]}')

    async def challenge_password(self,conn,user,response,*,legacy=False,native_context=None):
        factor=await self.factor(conn,user['id'])
        if not factor or not factor['totp_enabled']:return None
        challenge=secrets.token_hex(24) if legacy else 'flc_'+secrets.token_urlsafe(32)
        nonce=challenge if native_context else secrets.token_urlsafe(32)
        await conn.execute("DELETE FROM identity_challenges WHERE expires_at<=clock_timestamp()")
        await conn.execute("DELETE FROM identity_challenges WHERE user_id=%s AND purpose='password-login' AND id NOT IN (SELECT id FROM identity_challenges WHERE user_id=%s AND purpose='password-login' ORDER BY expires_at DESC LIMIT 7)",(user['id'],user['id']))
        await conn.execute("INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'password-login',%s,%s,%s,clock_timestamp()+interval '5 minutes')",(digest(challenge),user['id'],digest(nonce+':'+self.settings.public_origin),Jsonb({'stamp':self.factor_stamp(user,factor),**({'native':native_context} if native_context else {})})))
        if not native_context:
            response.set_cookie(FACTOR_COOKIE,nonce,httponly=True,secure=self.settings.secure_cookie,samesite='strict',max_age=300,path='/')
        return {'status':'requires_2fa','challenge_token':challenge,'expires_in':300,'factors':['totp','backup_code']}

    async def consume(self,conn,user_id,code):
        factor=await self.factor(conn,user_id)
        if not factor or not factor['totp_enabled']:return False
        secret=self.vault.decrypt(factor['totp_secret_ciphertext'],'totp:'+user_id,self.settings.instance_id)
        step=verify_totp(secret,code,factor['totp_last_step'])
        if step is not None:
            await conn.execute('UPDATE identity_security SET totp_last_step=%s WHERE user_id=%s',(step,user_id))
            return True
        if not factor['backup_codes']:return False
        key=(bytes.fromhex(self.vault.decrypt(factor['backup_key_ciphertext'],'backup-key:'+user_id,self.settings.instance_id)) if factor['backup_key_ciphertext'] else hashlib.sha256(self.vault.key()).digest())
        accepted,remaining=consume_backup(code,factor['backup_codes'],key)
        if accepted:await conn.execute('UPDATE identity_security SET backup_codes=%s WHERE user_id=%s',(Jsonb(remaining),user_id))
        return accepted

    async def finish_password(self, token, code, nonce, request_id, create_session):
        result = None
        async with self.db.connection() as conn, conn.transaction():
            # Factor management owns the user row before invalidating challenges. Match that
            # order so disabling a factor cannot deadlock with a concurrent factor login.
            candidate = await (await conn.execute(
                "SELECT user_id FROM identity_challenges WHERE id=%s AND purpose='password-login'",
                (digest(token),),
            )).fetchone()
            user = await (await conn.execute(
                'SELECT * FROM users WHERE id=%s FOR UPDATE', (candidate['user_id'],),
            )).fetchone() if candidate else None
            challenge = await (await conn.execute(
                "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='password-login' FOR UPDATE",
                (digest(token),),
            )).fetchone()
            valid = bool(user and challenge and challenge['user_id'] == user['id']
                         and challenge['valid'] and challenge['attempts'] < 8
                         and hmac.compare_digest(challenge['binding'], digest(nonce + ':' + self.settings.public_origin)))
            if valid:
                factor = await self.factor(conn, user['id'])
                valid = bool(user['active'] and factor and factor['totp_enabled']
                             and hmac.compare_digest(challenge['payload']['stamp'], self.factor_stamp(user, factor)))
                await conn.execute('UPDATE identity_challenges SET attempts=attempts+1 WHERE id=%s', (digest(token),))
                if valid and await self.consume(conn, user['id'], code):
                    await conn.execute('DELETE FROM identity_challenges WHERE id=%s', (digest(token),))
                    session_token, session = await create_session(conn, user, request_id)
                    await conn.execute("UPDATE sessions SET auth_method='totp' WHERE token_hash=%s", (digest(session_token),))
                    result = (user, session_token, session)
                else:
                    await conn.execute("INSERT INTO audit_events(action,target_id) VALUES('identity.factor.rejected',%s)", (challenge['user_id'],))
        # Rejections commit their attempt count; they must not roll back with an exception.
        if not result:
            raise HTTPException(403, '验证码或备用码不正确，或验证已失效')
        return result
