"""One original legacy settings receipt over the existing configuration authorities."""

import json
import secrets
from contextlib import asynccontextmanager
from uuid import UUID, uuid4, uuid5
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .market_worker import Bound
from .notification_security import NotificationSecurity
from .private_runtime_settings import PrivateRuntimeSettings
from .security import digest, lock_mutation_identity
from .site_settings import ASSETS, DEFAULTS, SiteSettings, public_projection
from .site_settings_layout import DEFAULTS as LAYOUT_DEFAULTS


COMMANDS = {
    'request_id', 'requestId', 'revision', 'expectedRevision', 'privateRevision',
    'private_revision', 'modelServicesRevision', 'currentPassword', 'current_password', 'password', 'code',
}
PROOFS = {'currentPassword', 'current_password', 'password', 'code'}


def one(raw, names, default=None):
    values = [raw[name] for name in names if name in raw]
    if len(values) > 1:
        raise HTTPException(422, '同一配置证明不能重复提供')
    return values[0] if values else default


class LegacySettingsBridge:
    def __init__(self, db, app=None):
        self.db,self.app = db,app

    async def receipt(self, who, identifier):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            installed = await (await conn.execute(
                "SELECT to_regclass('public.legacy_settings_receipts') AS name"
            )).fetchone()
            if not installed['name']:
                raise HTTPException(404, '原设置操作尚未找到')
            row = await (await conn.execute(
                'SELECT result FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',
                (who.id, identifier),
            )).fetchone()
            if not row:
                admitted=await(await conn.execute('SELECT * FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
                if admitted:return self.pending(admitted)
                raise HTTPException(404, '原设置操作尚未找到')
            return row['result']

    @staticmethod
    def pending(admission):
        return {'requestId':str(admission['request_id']),'state':'unknown','httpStatus':202,'willRetryAutomatically':False,'settingsApplied':False,
            'childRequestId':str(admission['child_request_id']),'receiptUrl':'/api/settings/operations/'+str(admission['request_id']),'originInstance':str(admission['origin_instance'])}

    @asynccontextmanager
    async def parent_transaction(self,rid,fingerprint,admission_id,actor):
        try:
            async with self.db.connection()as conn,conn.transaction():yield conn
        except HTTPException as error:
            if admission_id:
                async with self.db.connection()as history,history.transaction():
                    row=await(await history.execute('SELECT a.* FROM legacy_settings_admissions a JOIN alcor_instance i ON i.singleton AND i.instance_id=a.origin_instance WHERE a.actor_id=%s AND a.request_id=%s AND a.admission_id=%s AND a.fingerprint=%s',(actor,rid,admission_id,fingerprint))).fetchone()
                    if row:
                        result={'requestId':str(rid),'state':'rejected','httpStatus':error.status_code,'settingsApplied':False,'transactionRolledBack':True,'reason':str(error.detail),'childRequestId':str(row['child_request_id']),'receiptUrl':'/api/settings/operations/'+str(rid)}
                        await history.execute('INSERT INTO legacy_settings_receipts(actor_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)ON CONFLICT DO NOTHING',(actor,rid,fingerprint,Jsonb(result)))
            raise

    async def schedule(self, conn, who, pattern, timezone, password, code, verifier):
        from .admin_verification import require_admin_verification
        from .fx_custom import decrypt_existing, existing_key
        from .fx_service import ManagedFx

        if password:
            user = await verifier.step_up(conn, who, password, code)
            await conn.execute(
                "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) "
                "VALUES(%s,'reference-reauth',%s,%s,%s,clock_timestamp()+interval '15 minutes') "
                "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at",
                (digest('reference-reauth:' + who.token_hash), who.id, who.token_hash,
                 Jsonb({'session_version': user['session_version']})),
            )
        await require_admin_verification(conn, who, 'reference')
        row = await (await conn.execute(
            'SELECT c.*,p.config,p.secret_cipher,p.credential_instance,p.id AS provider_id '
            'FROM fx_config c LEFT JOIN fx_provider_revisions p ON p.id=c.provider_revision '
            'WHERE c.singleton FOR UPDATE OF c',
        )).fetchone()
        if not row or not row['provider_revision']:
            raise HTTPException(409, '请先在汇率来源中登记明确目标和时区，再保存刷新计划')
        config = row['config']
        timezone = timezone or (config.get('schedule') or {}).get('timezone')
        if not timezone:
            raise HTTPException(422, '汇率刷新计划需要明确时区')
        provider = await (await conn.execute(
            'SELECT * FROM fx_provider_revisions WHERE id=%s', (row['provider_revision'],),
        )).fetchone()
        secret = json.loads(decrypt_existing(existing_key(self.db.settings), provider))
        custom = {key: config[key] for key in ('declared_base', 'time_field', 'time_precision') if key in config}
        custom.update(secret)
        custom['schedule'] = {'pattern': pattern, 'timezone': timezone}
        try:
            return await ManagedFx(Bound(conn, self.db.settings)).configure(
                who, row['enabled'], row['daily_budget'], row['revision'], custom,
            )
        except (ValueError, KeyError, TypeError, TimeoutError, OSError):
            raise HTTPException(422, '汇率来源或刷新计划未通过核对') from None

    async def save(self, who, raw, site_service, verifier, *, legacy=False, header_id=None):
        factor_security=NotificationSecurity(self.db)
        class SameTransactionVerifier:
            """One current factor can authorize this explicit multi-authority transaction."""
            def __init__(self, original):
                self.original, self.checked = original, None

            async def step_up(self, conn, principal, password, code):
                if self.checked is None:
                    user = await self.original.step_up(conn, principal, password, code)
                    self.checked = (conn, principal.id, principal.token_hash, password, code, user)
                    self.factor_stamp=await factor_security.identity_stamp(conn,principal)
                    return user
                old_conn, actor, token, old_password, old_code, user = self.checked
                if (actor != principal.id or token != principal.token_hash
                        or not secrets.compare_digest(old_password.encode(), password.encode())
                        or not secrets.compare_digest(old_code.encode(), code.encode())):
                    raise HTTPException(403, '管理员验证上下文已变化')
                if not secrets.compare_digest(self.factor_stamp,await factor_security.identity_stamp(conn,principal)):raise HTTPException(403,'管理员安全因子已变化，请重新核对')
                if conn is not old_conn:
                    current=await(await conn.execute('SELECT password_hash,session_version,active,role FROM users WHERE id=%s',(principal.id,))).fetchone()
                    if not current or not current['active']or current['role']!='admin'or current['password_hash']!=user['password_hash']or current['session_version']!=user['session_version']:raise HTTPException(403,'管理员验证上下文已变化')
                return user

        verifier = SameTransactionVerifier(verifier)
        try:
            supplied = one(raw, ('requestId', 'request_id'), header_id)
            if header_id is not None and supplied is not None and UUID(header_id) != UUID(supplied):
                raise HTTPException(422, '原请求UUID不一致')
            if supplied is None and not legacy:
                raise HTTPException(422, '保存需要原请求UUID')
            rid = UUID(supplied) if supplied is not None else uuid4()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '原请求UUID无效') from None
        logical = {key: value for key, value in raw.items() if key not in PROOFS}
        fingerprint = NotificationSecurity(self.db).mac(logical, create=True)
        password = one(raw, ('password', 'currentPassword', 'current_password'), '')
        code = raw.get('code', '')
        if not isinstance(password, str) or not isinstance(code, str):
            raise HTTPException(422, '管理员验证格式无效')
        connection_prepared=None;parent_admission_id=None
        from .legacy_connection_settings import KEYS as PG_KEYS,prepare as prepare_connection
        if set(raw)&PG_KEYS:
            if self.app is None:raise HTTPException(503,'数据库配置权威尚未接线')
            async with self.db.connection()as initial,initial.transaction():
                await lock_mutation_identity(initial,who)
                prior=await(await initial.execute('SELECT fingerprint,result FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
                if prior:
                    if prior['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于不同设置')
                    return prior['result']
                existing=await(await initial.execute('SELECT * FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
                if existing:
                    if existing['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于不同设置')
                    return self.pending(existing)
                parent_admission_id=uuid4()
                await initial.execute('INSERT INTO legacy_settings_admissions(actor_id,request_id,fingerprint,origin_instance,admission_id,child_request_id)VALUES(%s,%s,%s,%s,%s,%s)',(who.id,rid,fingerprint,self.db.settings.instance_id,parent_admission_id,uuid5(rid,'legacy-settings-postgresql')))
            connection_prepared=await prepare_connection(self.db,self.app.state.connections,who,rid,raw,verifier,password,code)
        async with self.parent_transaction(rid,fingerprint,parent_admission_id,who.id) as conn:
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                               ('identity-management:' + who.id,))
            await lock_mutation_identity(conn, who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('private-runtime-settings',0))")
            prior = await (await conn.execute(
                'SELECT fingerprint,result FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',
                (who.id, rid),
            )).fetchone()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise HTTPException(409, '原UUID已用于不同设置')
                return prior['result']
            if parent_admission_id:
                admission=await(await conn.execute('SELECT a.* FROM legacy_settings_admissions a JOIN alcor_instance i ON i.singleton AND i.instance_id=a.origin_instance WHERE a.actor_id=%s AND a.request_id=%s AND a.admission_id=%s AND a.fingerprint=%s',(who.id,rid,parent_admission_id,fingerprint))).fetchone()
                if not admission:raise HTTPException(409,'原设置执行权或恢复实例已变化')
            bound = Bound(conn, self.db.settings)
            private = PrivateRuntimeSettings(bound)
            private_revision, _ = await private.private_on_connection(conn)
            supplied_private=one(raw,('privateRevision','private_revision','modelServicesRevision'))
            if supplied_private is not None and (type(supplied_private)is not int or supplied_private!=private_revision):raise HTTPException(409,'私有配置修订已变化')
            row = await (await conn.execute('SELECT * FROM site_settings WHERE singleton FOR UPDATE')).fetchone()
            if not row:
                raise HTTPException(503, '站点配置尚未初始化')
            visible = await public_projection(conn, row, site_service.mail.configured)
            public_patch = {key: None if key in ASSETS and value == '' else value
                            for key, value in raw.items() if key in DEFAULTS or key in LAYOUT_DEFAULTS or key == 'allowRegister'}
            # A full old form does not become a public-brand mutation merely by
            # echoing unchanged public projection fields alongside private edits.
            public_patch = {key: value for key, value in public_patch.items()
                            if value != visible.get(key) and value != row['settings'].get(key, DEFAULTS.get(key))}
            for key, kind in ASSETS.items():
                value = public_patch.get(key)
                if not isinstance(value, str) or not value.startswith('/uploads/'):
                    continue
                parsed = urlsplit(value)
                hashes = parse_qs(parsed.query).get('sha256', [])
                if parsed.fragment or set(parse_qs(parsed.query)) - {'sha256'} or len(hashes) > 1:
                    raise HTTPException(422, '品牌素材版本无效')
                if hashes:
                    asset = await (await conn.execute(
                        'SELECT id FROM system_asset_versions WHERE public_path=%s AND served_sha256=%s '
                        'AND kind=%s ORDER BY created_at DESC LIMIT 1', (parsed.path, hashes[0], kind),
                    )).fetchone()
                else:
                    asset = await (await conn.execute(
                        'SELECT v.id FROM system_asset_paths p JOIN system_asset_versions v ON v.id=p.current_version '
                        'WHERE p.public_path=%s AND v.kind=%s', (parsed.path, kind),
                    )).fetchone()
                if not asset:
                    raise HTTPException(409, '品牌图片尚未登记为平台版本')
                public_patch[key] = str(asset['id'])
            private_patch = {key: value for key, value in raw.items()
                             if key not in COMMANDS and key not in DEFAULTS and key not in LAYOUT_DEFAULTS and key != 'allowRegister'}
            pattern = private_patch.pop('currencyRefreshPattern', None)
            timezone = private_patch.pop('currencyRefreshTimezone', None)
            effects = []
            if connection_prepared:
                data,prepared=connection_prepared
                if password:await verifier.step_up(conn,who,password,code)
                effect=await self.app.state.connections.finalize_on_connection(conn,who,data,prepared,'save')
                effects.append({'authority':'connections','operation':effect})
                if effect['status']not in ('passed','pending','saved'):
                    result={'requestId':str(rid),'state':'unknown'if effect['status']=='unknown'else'rejected','httpStatus':202 if effect['status']=='unknown'else 502,'effects':effects,'settingsUnchanged':True,'receiptUrl':'/api/settings/operations/'+str(rid)}
                    await conn.execute('INSERT INTO legacy_settings_receipts(actor_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)',(who.id,rid,fingerprint,Jsonb(result)))
                    return result
                for key in PG_KEYS:private_patch.pop(key,None)
            if self.app is not None and {'groups','ticker'}&set(private_patch):
                from .legacy_settings_domains import apply_domains
                domain_result=await apply_domains(conn,self.app,who,rid,private_patch,private_revision=private_revision)
                private_revision=domain_result['privateRevision'];effects.extend(domain_result['effects'])
                for field in domain_result['consumedFields']:private_patch.pop(field,None)
            if public_patch:
                revision = one(raw, ('expectedRevision', 'revision'), row['revision'] if legacy else None)
                if type(revision) is not int:
                    raise HTTPException(422, '需要当前公开设置版本')
                result = await SiteSettings(bound, site_service.mail).save(
                    who, uuid5(rid, 'public-settings'), revision, public_patch, password, code, verifier,
                )
                effects.append({'authority': 'public-site', 'operation': result})
            if private_patch:
                expected = one(raw, ('privateRevision', 'private_revision', 'modelServicesRevision'), private_revision if legacy else None)
                if expected is None and not public_patch:
                    expected = one(raw, ('expectedRevision', 'revision'))
                if type(expected) is not int:
                    raise HTTPException(422, '需要当前私有设置版本')
                if supplied_private is not None:expected=private_revision
                result = await private.save_legacy(who, private_patch, rid, expected, connection=conn,password=password,code=code,verifier=verifier)
                effects.append({'authority': 'private-runtime', 'operation': result})
            if pattern is not None:
                revision = await self.schedule(conn, who, pattern, timezone, password, code, verifier)
                effects.append({'authority': 'reference-rates', 'revision': revision})
            current = await (await conn.execute('SELECT * FROM site_settings WHERE singleton')).fetchone()
            state = await private.read_admin(who)
            values = await public_projection(conn, current, site_service.mail.configured)
            from .site_settings_layout import project as layout_projection
            values.update(await layout_projection(conn,current))
            from .legacy_settings_projection import project as private_projection
            values.update(private_projection(state['groups']))
            from .legacy_settings_projection import current_channels
            values.update(await current_channels(conn,self.db,who))
            directory=await(await conn.execute('SELECT groups FROM shared_broker_directory WHERE singleton')).fetchone()
            if directory:values['groups']=directory['groups']
            result = {'settings': values, 'revision': current['revision'], 'privateRevision': state['revision'],
                      'requestId': str(rid), 'state': 'completed', 'effects': effects,
                      'migration': {'status': 'pending_validation', 'privateFieldsWritten': bool(private_patch),
                                    'sourceCoverage': 'platform-authorities'},
                      'receiptUrl': '/api/settings/operations/' + str(rid)}
            await conn.execute(
                'INSERT INTO legacy_settings_receipts(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',
                (who.id, rid, fingerprint, Jsonb(result)),
            )
            return result
