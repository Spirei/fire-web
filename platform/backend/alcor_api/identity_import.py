"""Atomic, explicitly addressed trial import. Reads a snapshot, never a legacy API or DB."""
import base64
import hashlib
import json
import re
import ipaddress
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4
from pydantic import Field, SecretStr, field_validator, model_validator
from psycopg.types.json import Jsonb
from webauthn.helpers import decode_credential_public_key
from .models import InputModel
from .connections import Vault
from .native_identity import decode_legacy_secret, totp_code


class SnapshotUser(InputModel):
    id: str = Field(min_length=1,max_length=128)
    username: str = Field(min_length=1,max_length=80)
    email: str = Field(default='',max_length=254)
    password_hash: SecretStr
    role: str = Field(pattern=r'^(admin|user)$')
    active: bool
    created_at: datetime
    email_verified: bool = False
    nickname: str = Field(default='',max_length=80)
    uid: str = Field(default='',max_length=128)
    avatar: str = Field(default='',max_length=65500)
    avatar_data: str | None = Field(default=None,max_length=65500)
    avatar_original_base64: str | None = Field(default=None,max_length=6990508)
    avatar_original_type: str | None = Field(default=None,pattern=r'^image/(jpeg|png|gif|webp)$')
    is_test: bool = False
    totp_enabled: bool = False
    totp_secret: SecretStr = SecretStr('')
    totp_last_step: int = Field(default=-1,ge=-1)
    totp_backup_codes: list[str] = Field(default_factory=list,max_length=8)
    totp_device_name: str = Field(default='',max_length=64)

    @model_validator(mode='after')
    def valid(self):
        if not re.fullmatch(r'[^:]{1,128}:[a-fA-F0-9]{128}',self.password_hash.get_secret_value()):
            raise ValueError('Unsupported source password hash')
        if self.created_at.tzinfo is None:
            raise ValueError('Source timestamp requires a timezone')
        if self.totp_enabled and not self.totp_secret.get_secret_value():
            raise ValueError('Enabled factor must retain its source secret')
        if (self.avatar_original_base64 is None)!=(self.avatar_original_type is None) or self.avatar_data and self.avatar_original_base64 is not None:
            raise ValueError('Source avatar representation is ambiguous or incomplete')
        if any(not re.fullmatch(r'(?:v2:)?[a-f0-9]{64}',v) for v in self.totp_backup_codes):
            raise ValueError('Unsupported backup code hash')
        return self


class SnapshotPasskey(InputModel):
    id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,2048}$')
    user_id: str
    user_handle: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    rp_id: str = Field(min_length=1,max_length=253)
    public_key: str = Field(min_length=1,max_length=16384)
    counter: int = Field(ge=0)
    transports: list[str] = Field(default_factory=list,max_length=8)
    name: str = Field(min_length=1,max_length=64)
    backed_up: bool
    created_at: datetime
    last_used_at: datetime | None = None


class SnapshotPasskeyConfig(InputModel):
    enabled: bool
    origin: str
    rp_id: str
    name: str = Field(min_length=1,max_length=64)
    revision: str

    @model_validator(mode='after')
    def valid(self):
        u=urlsplit(self.origin)
        if self.enabled or self.origin:
            if u.scheme!='https' and not(u.scheme=='http' and u.hostname=='localhost'):
                raise ValueError('Passkey source origin must be HTTPS')
            if not u.hostname or u.hostname!=self.rp_id or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
                raise ValueError('Source RP ID and origin do not match')
        if u.hostname:
            try: ipaddress.ip_address(u.hostname)
            except ValueError: pass
            else: raise ValueError('Passkey RP ID must be a domain')
        return self


class SnapshotSession(InputModel):
    token_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    user_id: str
    created_at: datetime
    expires_at: datetime
    auth_method: str = Field(pattern=r'^(password|passkey|legacy|totp)$')
    passkey_id: str | None = None

class SnapshotGrant(InputModel):
    id: str = Field(pattern=r'^fg_[A-Za-z0-9_-]{1,128}$')
    user_id: str
    client_id: str = Field(pattern=r'^fire-ios$')
    scope: str = Field(max_length=512)
    device_name: str = Field(max_length=64)
    security_stamp: str = Field(pattern=r'^[a-f0-9]{64}$')
    passkey_id: str | None = None
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    revoked_at: datetime | None = None

class SnapshotAccess(InputModel):
    token_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    grant_id: str
    expires_at: datetime

class SnapshotRefresh(InputModel):
    token_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    grant_id: str
    used_at: datetime | None = None

class SnapshotConsent(InputModel):
    user_id: str
    client_id: str = Field(pattern=r'^fire-ios$')
    scope: str = Field(max_length=512)
    security_stamp: str = Field(pattern=r'^[a-f0-9]{64}$')
    revision: str = Field(max_length=128)
    updated_at: datetime


class IdentitySnapshot(InputModel):
    version: int = Field(ge=1,le=1)
    source_origin: str
    users: list[SnapshotUser] = Field(max_length=10000)
    passkeys: list[SnapshotPasskey] = Field(default_factory=list,max_length=200000)
    passkey_config: SnapshotPasskeyConfig
    sessions: list[SnapshotSession] = Field(default_factory=list,max_length=200000)
    app_grants: list[SnapshotGrant] = Field(default_factory=list,max_length=200000)
    app_access_tokens: list[SnapshotAccess] = Field(default_factory=list,max_length=400000)
    app_refresh_tokens: list[SnapshotRefresh] = Field(default_factory=list,max_length=400000)
    app_account_consents: list[SnapshotConsent] = Field(default_factory=list,max_length=10000)


async def import_trial_snapshot(db, raw: dict, *, source_key: bytes | None, expected_database: str):
    # This task authorizes isolated trial only. No production import path is exposed.
    if db.settings.environment!='test':
        raise ValueError('Only an isolated trial import is authorized')
    snapshot=IdentitySnapshot.model_validate(raw)
    fingerprint=hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    vault=Vault(db.settings.connection_secret_dir)
    user_ids={u.id for u in snapshot.users}
    logins=[v.lower() for u in snapshot.users for v in (u.username,u.email) if v]
    if len(user_ids)!=len(snapshot.users) or len(logins)!=len(set(logins)):
        raise ValueError('Source user identifiers are ambiguous')
    prepared=[]
    for u in snapshot.users:
        secret=decode_legacy_secret(u.totp_secret.get_secret_value(),source_key)
        if secret:totp_code(secret,0)
        if any(code.startswith('v2:') for code in u.totp_backup_codes) and not source_key:
            raise ValueError('Source data key is required for existing backup codes')
        from .profiles import normalize_avatar
        original=None
        image=u.avatar_data or (u.avatar if u.avatar.startswith('data:') else None)
        if u.avatar_original_base64 is not None:
            from .profile_media import validate_legacy_avatar
            if image or db.settings.file_root is None:raise ValueError('Source original avatar requires unambiguous private media storage')
            try:raw_avatar=base64.b64decode(u.avatar_original_base64,validate=True)
            except ValueError:raise ValueError('Invalid source avatar bytes') from None
            extension={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'}[u.avatar_original_type]
            original=validate_legacy_avatar(raw_avatar,extension)
        if u.avatar and not image and original is None:raise ValueError('Source avatar bytes are required; do not discard the original image')
        avatar=normalize_avatar(image) if image else None
        prepared.append((u,secret,avatar,original))
    keys=[]
    for key in snapshot.passkeys:
        if key.user_id not in user_ids or key.rp_id!=snapshot.passkey_config.rp_id:
            raise ValueError('Credential source user/RP does not match')
        try:
            public=base64.b64decode(key.public_key,validate=True)
            decode_credential_public_key(public)
        except Exception:raise ValueError('Source credential public key is invalid') from None
        if key.created_at.tzinfo is None or (key.last_used_at and key.last_used_at.tzinfo is None):
            raise ValueError('Credential timestamp requires timezone')
        keys.append((key,public))
    from .native_app_auth import parse_scopes
    grants={grant.id for grant in snapshot.app_grants}
    if len(grants)!=len(snapshot.app_grants):raise ValueError('Duplicate source grant IDs')
    for row in [*snapshot.sessions,*snapshot.app_grants,*snapshot.app_account_consents]:
        if row.user_id not in user_ids:raise ValueError('Source token owner does not exist')
        for field in ('created_at','last_used_at','expires_at','revoked_at','updated_at'):
            value=getattr(row,field,None)
            if value is not None and value.tzinfo is None:raise ValueError('Source token time requires timezone')
    for row in [*snapshot.app_access_tokens,*snapshot.app_refresh_tokens]:
        if row.grant_id not in grants:raise ValueError('Source token grant does not exist')
        for field in ('expires_at','used_at'):
            value=getattr(row,field,None)
            if value is not None and value.tzinfo is None:raise ValueError('Source token time requires timezone')
    for row in [*snapshot.app_grants,*snapshot.app_account_consents]:parse_scopes(row.scope)
    async with db.connection() as conn,conn.transaction():
        if (await (await conn.execute('SELECT current_database() AS name')).fetchone())['name']!=expected_database:
            raise ValueError('Trial database confirmation does not match')
        await conn.execute('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
        old=await (await conn.execute('SELECT user_count,key_count FROM identity_migrations WHERE fingerprint=%s',(fingerprint,))).fetchone()
        if old:return {'already_imported':True,**old}
        # A trial never merges or overwrites existing identities.
        if await (await conn.execute('SELECT 1 FROM users LIMIT 1')).fetchone():
            raise ValueError('Trial identity import requires an empty user set')
        for u,secret,avatar,original in prepared:
            await conn.execute('INSERT INTO users(id,username,email,password_hash,role,active,created_at,is_test) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(u.id,u.username,u.email,u.password_hash.get_secret_value(),u.role,u.active,u.created_at,u.is_test))
            await conn.execute('INSERT INTO user_profiles(user_id,display_name,avatar,revision) VALUES(%s,%s,%s,%s)',(u.id,u.nickname,avatar,uuid4()))
            if original is not None:
                from .profile_media import ProfileMedia
                object_id,_=await ProfileMedia(db.settings).stage(conn,u.id,*original)
                await conn.execute('UPDATE user_profiles SET avatar_object_id=%s WHERE user_id=%s',(object_id,u.id))
            await conn.execute('INSERT INTO identity_source_profiles(user_id,metadata) VALUES(%s,%s)',(u.id,Jsonb({'uid':u.uid,'nickname':u.nickname,'avatar':u.avatar,'is_test':u.is_test,'history_started_at':datetime.now(timezone.utc).isoformat()})))
            source_stamp=hashlib.sha256(f'{u.password_hash.get_secret_value()}:{int(u.totp_enabled)}:{u.totp_secret.get_secret_value()}'.encode()).hexdigest()
            await conn.execute('''INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,totp_last_step,backup_codes,backup_key_ciphertext,device_name,source_stamp,email_verified)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(u.id,u.totp_enabled,vault.encrypt(secret,'totp:'+u.id,db.settings.instance_id),u.totp_last_step,Jsonb(u.totp_backup_codes),vault.encrypt(hashlib.sha256(source_key).hexdigest(),'backup-key:'+u.id,db.settings.instance_id) if source_key else None,u.totp_device_name,source_stamp,u.email_verified))
        for key,public in keys:
            await conn.execute('''INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up,created_at,last_used_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(key.id,key.user_id,key.user_handle,key.rp_id,public,key.counter,Jsonb(key.transports),key.name,key.backed_up,key.created_at,key.last_used_at))
        for row in snapshot.sessions:
            await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,created_at,expires_at,auth_method,passkey_id) VALUES(%s,%s,'legacy-web',1,%s,%s,%s,%s)",(row.token_hash,row.user_id,row.created_at,row.expires_at,row.auth_method,row.passkey_id))
        for row in snapshot.app_grants:
            await conn.execute('INSERT INTO identity_app_grants(id,user_id,client_id,scope,device_name,security_stamp,session_version,passkey_id,created_at,last_used_at,expires_at,revoked_at) VALUES(%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s,%s)',(row.id,row.user_id,row.client_id,row.scope,row.device_name,row.security_stamp,row.passkey_id,row.created_at,row.last_used_at,row.expires_at,row.revoked_at))
        for row in snapshot.app_access_tokens:
            await conn.execute('INSERT INTO identity_app_access_tokens(token_hash,grant_id,expires_at) VALUES(%s,%s,%s)',(row.token_hash,row.grant_id,row.expires_at))
        for row in snapshot.app_refresh_tokens:
            await conn.execute('INSERT INTO identity_app_refresh_tokens(token_hash,grant_id,used_at) VALUES(%s,%s,%s)',(row.token_hash,row.grant_id,row.used_at))
        for row in snapshot.app_account_consents:
            await conn.execute('INSERT INTO identity_app_consents(user_id,client_id,scope,security_stamp,revision,updated_at) VALUES(%s,%s,%s,%s,%s,%s)',(row.user_id,row.client_id,row.scope,row.security_stamp,row.revision,row.updated_at))
        c=snapshot.passkey_config
        await conn.execute('UPDATE identity_passkey_config SET enabled=%s,origin=%s,rp_id=%s,name=%s,revision=%s WHERE singleton=true',(c.enabled,c.origin,c.rp_id,c.name,c.revision))
        await conn.execute('UPDATE registration_state SET bootstrap_completed=true,claimed_at=clock_timestamp() WHERE singleton=true')
        await conn.execute('INSERT INTO identity_migrations(fingerprint,source_origin,user_count,key_count) VALUES(%s,%s,%s,%s)',(fingerprint,snapshot.source_origin,len(prepared),len(keys)))
        await conn.execute("INSERT INTO audit_events(action,target_id) VALUES('identity.trial.imported',%s)",(fingerprint,))
    return {'already_imported':False,'user_count':len(prepared),'key_count':len(keys)}
