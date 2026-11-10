"""Last-step identity cutover using a fresh, locked source security snapshot."""
import base64
import hashlib
import json
from datetime import UTC,datetime,timedelta
from decimal import Decimal
from urllib.parse import urlsplit
from uuid import UUID,uuid4

from fastapi import HTTPException
from psycopg import sql
from psycopg.types.json import Jsonb
from webauthn.helpers import decode_credential_public_key

from .backups import BackupFailure,private_read
from .connections import Vault
from .database_migration_assets import input_manifest,original_bytes,plain
from .database_migration_capture import canonical,sha
from .database_migration_portfolio import complete_on_connection
from .identity_import import SnapshotUser
from .native_identity import decode_legacy_secret,totp_code


def passkey_time(value):
    if value is None:return None
    if isinstance(value,(int,Decimal)) and not isinstance(value,bool):
        return datetime(1970,1,1,tzinfo=UTC)+timedelta(milliseconds=int(value))
    stamp=value if isinstance(value,datetime) else datetime.fromisoformat(value)
    if stamp.tzinfo is None:raise ValueError('Source passkey timezone is missing')
    return stamp


def background_bytes(settings,value,files):
    """PG bytea and historical image URLs are distinct original representations."""
    from .profile_media import normalize_background
    if isinstance(value,(bytes,bytearray,memoryview)):raw=bytes(value)
    elif isinstance(value,str) and value.startswith('\\x'):
        try:raw=bytes.fromhex(value[2:])
        except ValueError:raise BackupFailure('原背景图片格式无效') from None
    elif isinstance(value,str) and value.startswith('data:image/jpeg;base64,'):
        try:raw=base64.b64decode(value.split(',',1)[1],validate=True)
        except ValueError:raise BackupFailure('原背景图片格式无效') from None
    elif isinstance(value,str) and value.startswith('/uploads/'):
        raw,_,_=original_bytes(settings,value,files)
    else:raise BackupFailure('原背景图片需要完整原件')
    normalize_background(raw)
    from PIL import Image
    from io import BytesIO
    with Image.open(BytesIO(raw)) as image:mime=Image.MIME.get(image.format)
    if mime not in ('image/jpeg','image/png','image/webp'):raise BackupFailure('原背景图片格式不可表达')
    return raw,mime


async def read_source(connection,plan,frozen):
    schema=plan['portfolio']['source_schema'];owner=plan['source_owner']
    scoped={'users':'id','passkeys':'user_id','verified_emails':'user_id','personal_profiles':'user_id','app_grants':'user_id','app_account_consents':'user_id','sessions':'user_id'}
    existing={name for ns,name in frozen.inventory if ns==schema}
    tables=[name for name in (*scoped,'passkey_config') if name in existing]
    await connection.execute(sql.SQL('LOCK TABLE {} IN SHARE MODE').format(sql.SQL(',').join(sql.Identifier(schema,name) for name in tables)))
    values={}
    for name,column in scoped.items():
        values[name]=await(await connection.execute(sql.SQL('SELECT * FROM {} WHERE {}=%s').format(sql.Identifier(schema,name),sql.Identifier(column)),(owner,))).fetchall() if name in existing else []
        if len(values[name])>20000:raise BackupFailure('原身份范围超过迁移预算')
    values['passkey_config']=await(await connection.execute(sql.SQL('SELECT * FROM {}').format(sql.Identifier(schema,'passkey_config')))).fetchall() if 'passkey_config' in existing else []
    if len(values['users'])!=1:raise BackupFailure('原账号身份不唯一')
    return values


def validated(settings,plan,values):
    root,files,_=input_manifest(settings,plan);key=private_read(root/'source-data.key',128)
    if len(key)!=32:raise BackupFailure('原身份密钥格式不正确')
    if len(values['users'])!=1 or str(values['users'][0].get('id'))!=plan['source_owner']:raise BackupFailure('原账号与所选来源不一致')
    raw=values['users'][0]
    try:
        user=SnapshotUser.model_validate({**{k:raw[k] for k in SnapshotUser.model_fields if k in raw},'active':True,'totp_enabled':bool(raw.get('totp_enabled')),
            'totp_backup_codes':json.loads(raw.get('totp_backup_codes') or '[]'),'is_test':bool(raw.get('is_test'))})
        secret=decode_legacy_secret(user.totp_secret.get_secret_value(),key)
        if secret:totp_code(secret,0)
        configs=values['passkey_config']
        config=json.loads(configs[0]['value']) if len(configs)==1 else None
        if values['passkeys'] and (not config or config.get('origin')!=settings.public_origin or config.get('rpID')!=urlsplit(settings.public_origin).hostname):raise ValueError()
        for row in values['passkeys']:
            if row['user_id']!=user.id or row['rp_id']!=config['rpID'] or int(row['counter'])<0:raise ValueError()
            public=row['public_key']
            public=bytes.fromhex(public[2:]) if isinstance(public,str) and public.startswith('\\x') else bytes(public)
            decode_credential_public_key(public)
            if passkey_time(row.get('created_at')) is None:raise ValueError()
            passkey_time(row.get('last_used_at'))
        for profile in values.get('personal_profiles',[]):
            if profile.get('background'):background_bytes(settings,profile['background'],files)
    except (ValueError,TypeError,KeyError):raise BackupFailure('原账号、两步验证或通行密钥尚未通过核对') from None
    return user,secret,key,config,files


async def execute(db,task,who,plan,frozen,source,stage_results,backup):
    values=await read_source(source,plan,frozen)
    user,secret,key,config,files=validated(db.settings,plan,values)
    vault=Vault(db.settings.connection_secret_dir,read_only=True)
    async with db.connection() as conn,conn.transaction():
        from .security import lock_mutation_identity
        await lock_mutation_identity(conn,who)
        current=await(await conn.execute('SELECT * FROM users WHERE id=%s FOR UPDATE',(who.id,))).fetchone()
        if not current or str(current['uid'])!=user.uid or bool(current['is_test'])!=user.is_test or user.role!=who.role:
            raise BackupFailure('新旧公开UID、账号类别或权限不一致，身份未切换')
        if await(await conn.execute('SELECT 1 FROM users WHERE id<>%s AND (lower(username)=lower(%s) OR (%s<>\'\' AND lower(email)=lower(%s)))',(who.id,user.username,user.email,user.email))).fetchone():raise BackupFailure('原登录名或邮箱与其他账号冲突')
        before={'source':plain(values),'target':{}}
        for table,column in (('users','id'),('identity_security','user_id'),('identity_passkeys','user_id'),('user_profiles','user_id'),('identity_source_profiles','user_id'),('sessions','user_id'),('identity_app_grants','user_id')):
            before['target'][table]=[dict(row) for row in await(await conn.execute(sql.SQL('SELECT * FROM {} WHERE {}=%s').format(sql.Identifier(table),sql.Identifier(column)),(who.id,))).fetchall()]
        # Ciphertext is stored only in the server-private immutable completion row.
        cipher=vault.encrypt(json.dumps(before,ensure_ascii=False,separators=(',',':'),default=lambda value:base64.b64encode(value).decode() if isinstance(value,(bytes,bytearray,memoryview)) else str(value)),'migration-identity:'+who.id,db.settings.instance_id)
        from .profile_media import ProfileMedia,validate_legacy_avatar
        from .profiles import normalize_avatar
        avatar_object=None;avatar=None
        if user.avatar:
            if user.avatar.startswith('data:'):
                avatar=normalize_avatar(user.avatar)
            else:
                raw,name,_=original_bytes(db.settings,user.avatar,files)
                validated_avatar=validate_legacy_avatar(raw,name.rsplit('.',1)[-1])
                avatar_object,_=await ProfileMedia(db.settings).stage(conn,who.id,*validated_avatar)
        profiles=values['personal_profiles'];profile=profiles[0] if len(profiles)==1 else {}
        background=profile.get('background');background_object=None;background_sha=None
        if background:
            raw,mime=background_bytes(db.settings,background,files)
            background_object,background_sha=await ProfileMedia(db.settings).stage(conn,who.id,raw,mime)
        gender=profile.get('gender') or 'unspecified'
        if gender not in ('unspecified','male','female'):raise BackupFailure('原个人资料性别字段不可表达')
        initialized=profile.get('initialized') or '[]'
        initialized=json.loads(initialized) if isinstance(initialized,str) else initialized
        if not isinstance(initialized,list) or set(initialized)-{'bio','gender','background'}:raise BackupFailure('原个人资料字段状态不可表达')
        await conn.execute('UPDATE users SET username=%s,email=%s,password_hash=%s,created_at=%s,session_version=session_version+1 WHERE id=%s',
            (user.username,user.email,user.password_hash.get_secret_value(),user.created_at,who.id))
        source_stamp=sha(f'{user.password_hash.get_secret_value()}:{int(user.totp_enabled)}:{user.totp_secret.get_secret_value()}'.encode())
        await conn.execute('''INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,totp_last_step,backup_codes,backup_key_ciphertext,device_name,source_stamp,email_verified)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET totp_enabled=excluded.totp_enabled,totp_secret_ciphertext=excluded.totp_secret_ciphertext,totp_last_step=excluded.totp_last_step,backup_codes=excluded.backup_codes,backup_key_ciphertext=excluded.backup_key_ciphertext,device_name=excluded.device_name,source_stamp=excluded.source_stamp,email_verified=excluded.email_verified''',
            (who.id,user.totp_enabled,vault.encrypt(secret,'totp:'+who.id,db.settings.instance_id),user.totp_last_step,Jsonb(user.totp_backup_codes),vault.encrypt(hashlib.sha256(key).hexdigest(),'backup-key:'+who.id,db.settings.instance_id),user.totp_device_name,source_stamp,bool(user.email and any(str(row.get('email') or '').lower()==user.email.lower() for row in values['verified_emails']))))
        await conn.execute('''INSERT INTO user_profiles(user_id,display_name,avatar,revision,avatar_object_id,bio,gender,initialized_fields,background_object_id,background_sha256)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,revision=excluded.revision,avatar_object_id=excluded.avatar_object_id,bio=excluded.bio,gender=excluded.gender,initialized_fields=excluded.initialized_fields,background_object_id=excluded.background_object_id,background_sha256=excluded.background_sha256,personal_revision=user_profiles.personal_revision+1''',
            (who.id,user.nickname,avatar,uuid4(),avatar_object,profile.get('bio') or '',gender,initialized,background_object,background_sha))
        await conn.execute('INSERT INTO identity_source_profiles(user_id,metadata) VALUES(%s,%s) ON CONFLICT(user_id) DO UPDATE SET metadata=excluded.metadata',
            (who.id,Jsonb({'uid':user.uid,'source_account_id':user.id,'source_instance':plan['portfolio']['source_instance'],'owner_mapping_preserved':True,'history_started_at':datetime.now(UTC).isoformat()})))
        for row in values['passkeys']:
            existing=await(await conn.execute('SELECT * FROM identity_passkeys WHERE id=%s FOR UPDATE',(row['id'],))).fetchone()
            if existing:
                if existing['user_id']!=who.id or existing['rp_id']!=row['rp_id'] or bytes(existing['public_key'])!=bytes(row['public_key']) or existing['user_handle']!=row['user_handle']:raise BackupFailure('通行密钥编号与当前凭据冲突')
                await conn.execute('UPDATE identity_passkeys SET counter=greatest(counter,%s) WHERE id=%s',(row['counter'],row['id']))
            else:
                transports=json.loads(row['transports']) if isinstance(row['transports'],str) else row['transports']
                await conn.execute('INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up,created_at,last_used_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (row['id'],who.id,row['user_handle'],row['rp_id'],row['public_key'],row['counter'],Jsonb(transports),row['name'],bool(row['backed_up']),passkey_time(row['created_at']),passkey_time(row['last_used_at'])))
        if config and (config.get('enabled') or config.get('origin') or values['passkeys']):
            if config.get('origin')!=db.settings.public_origin:raise BackupFailure('原通行密钥访问源与当前站点不一致')
            await conn.execute("UPDATE identity_passkey_config SET enabled=%s,origin=%s,rp_id=%s,name='Alcor',revision=%s WHERE singleton",(bool(config['enabled']),config['origin'],config['rpID'],str(uuid4())))
        # Old Web/App sessions are archived, never made active by a data import.
        await conn.execute("UPDATE identity_app_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE user_id=%s",(who.id,))
        from .worker import owned_row
        if not (lease:=await owned_row(conn,task)) or lease['status']!='running':raise BackupFailure('迁移已停止，身份未切换')
        result={'phase':'migration_completed','migration_complete':True,'business_written':True,'cutover_ready':True,'history_imported':True,'cash_history_imported':True,'cash_posted':False,
            'identity_switched':True,'login_required':True,'source_public_uid_preserved':True,'owner_id_mapping_retained':True,'password_hash_preserved':True,'totp_preserved':True,
            'passkeys_preserved':len(values['passkeys']),'old_sessions_archived':len(values['sessions']),'old_app_grants_archived':len(values['app_grants']),
            'conversion_id':task['payload']['conversion_id'],'stages':stage_results,'backup':backup,'financial_reconciled':False,'fee_policy':'retain_unverified','created_at':datetime.now(UTC).isoformat()}
        await conn.execute('INSERT INTO database_migration_completion_imports(owner_id,request_id,task_id,source_instance,source_owner,conversion_id,fingerprint,before_identity_ciphertext,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (who.id,task['request_id'],task['id'],plan['portfolio']['source_instance'],plan['source_owner'],UUID(task['payload']['conversion_id']),task['fingerprint'],cipher,Jsonb(result)))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.completed',%s,%s)",(who.id,plan['source_owner'],task['request_id']))
        await complete_on_connection(conn,task,result)
    return result
