"""PG-authoritative passkey administration shared by independent Web adapters."""
import re
import secrets
from urllib.parse import urlsplit

import idna
from fastapi import HTTPException
from .identity_import import SnapshotPasskeyConfig
from .security import lock_mutation_identity


def public_config(row):
    return {'enabled': row['enabled'], 'origin': row['origin'], 'rpID': row['rp_id'], 'name': row['name'], 'revision': row['revision']}


class PasskeyManagement:
    def __init__(self, settings, db, passkeys):
        self.settings, self.db, self.passkeys = settings, db, passkeys

    async def config(self):
        async with self.db.connection() as conn:
            row = await (await conn.execute('SELECT * FROM identity_passkey_config WHERE singleton=true')).fetchone()
        return public_config(row)

    async def list(self, who):
        async with self.db.connection() as conn:
            rows = await (await conn.execute('SELECT id,name,rp_id,created_at,last_used_at,backed_up FROM identity_passkeys WHERE user_id=%s ORDER BY created_at DESC', (who.id,))).fetchall()
            factor = await (await conn.execute('SELECT totp_enabled FROM identity_security WHERE user_id=%s', (who.id,))).fetchone()
        return {
            'keys': [{'id': row['id'], 'name': row['name'], 'rpID': row['rp_id'], 'createdAt': int(row['created_at'].timestamp() * 1000), 'lastUsedAt': int(row['last_used_at'].timestamp() * 1000) if row['last_used_at'] else None, 'backedUp': row['backed_up']} for row in rows],
            'totpEnabled': bool(factor and factor['totp_enabled']),
        }

    def candidate(self, data):
        try:
            name, raw = data.name.strip(), data.origin.strip()
            if not name or len(name.encode('utf-16-le')) // 2 > 64 or any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise ValueError()
            # urlsplit discards embedded ASCII tabs/newlines; reject them before
            # parsing rather than silently validating a different origin.
            if '\\' in raw or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in raw):
                raise ValueError()
            url = urlsplit(raw)
            if url.path not in {'', '/'} or url.query or url.fragment or url.username or url.password:
                raise ValueError()
            host = url.hostname or ''
            if host:
                host = idna.encode(host, uts46=True, std3_rules=True).decode('ascii').lower()
                labels = host.split('.')
                if (len(host) > 253 or host.endswith('.')
                        or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)
                        or re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]+)', labels[-1])):
                    # Browsers interpret numeric/hex terminal labels as IPv4
                    # candidates, including compact forms such as 127.1.
                    raise ValueError()
            port = url.port
            origin = ''
            if raw:
                authority = host + (':' + str(port) if port is not None and (url.scheme, port) not in {('https', 443), ('http', 80)} else '')
                origin = url.scheme + '://' + authority
            candidate = SnapshotPasskeyConfig(enabled=data.enabled, origin=origin, rp_id=host, name=name, revision=data.revision or '')
        except (ValueError, AttributeError, TypeError, UnicodeError):
            raise HTTPException(422, '通行密钥地址或站点名称不正确') from None
        if candidate.enabled and candidate.origin != self.settings.public_origin:
            raise HTTPException(422, '通行密钥地址必须与当前平台公开地址一致')
        return candidate

    async def configure(self, data, who, *, expected_optional=False):
        candidate = self.candidate(data)
        if data.revision is None and not expected_optional:
            raise HTTPException(422, '请提供当前登录设置版本')
        async with self.db.connection() as conn, conn.transaction():
            # Configuration first in both ceremony and configuration-update lock order.
            current = await (await conn.execute('SELECT * FROM identity_passkey_config WHERE singleton=true FOR UPDATE')).fetchone()
            await self.passkeys.serialize(conn, who)
            await lock_mutation_identity(conn, who, require_admin=True)
            await self.passkeys.step_up(conn, who, data.password, data.code)
            expected = current['revision'] if data.revision is None and expected_optional else data.revision
            if current['revision'] != expected:
                raise HTTPException(409, '登录设置已更新，请重新读取')
            if all(current[field] == getattr(candidate, attr) for field, attr in (('enabled', 'enabled'), ('origin', 'origin'), ('rp_id', 'rp_id'), ('name', 'name'))):
                return public_config(current)
            revision = secrets.token_hex(16)
            await conn.execute('UPDATE identity_passkey_config SET enabled=%s,origin=%s,rp_id=%s,name=%s,revision=%s WHERE singleton=true', (candidate.enabled, candidate.origin, candidate.rp_id, candidate.name, revision))
            await conn.execute("DELETE FROM identity_challenges WHERE purpose LIKE 'passkey-%'")
            await conn.execute("INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.passkey_config.updated')", (who.id,))
            return {'enabled': candidate.enabled, 'origin': candidate.origin, 'rpID': candidate.rp_id, 'name': candidate.name, 'revision': revision}

    async def rename(self, data, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.passkeys.serialize(conn, who)
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (await conn.execute('UPDATE identity_passkeys SET name=%s WHERE id=%s AND user_id=%s RETURNING id', (data.name, data.id, who.id))).fetchone()
            if not row:
                raise HTTPException(404, '通行密钥不存在')
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'identity.passkey.renamed',%s)", (who.id, data.id))
        return {'ok': True, 'signedOut': False}

    async def remove(self, data, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.passkeys.serialize(conn, who)
            await self.passkeys.step_up(conn, who, data.password, data.code)
            row = await (await conn.execute('DELETE FROM identity_passkeys WHERE id=%s AND user_id=%s RETURNING id', (data.id, who.id))).fetchone()
            if not row:
                raise HTTPException(404, '通行密钥不存在')
            await conn.execute("DELETE FROM sessions WHERE user_id=%s AND (passkey_id=%s OR auth_method='legacy')", (who.id, data.id))
            await conn.execute('UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s', (who.id,))
            await conn.execute('UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s AND passkey_id=%s', (who.id, data.id))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'identity.passkey.removed',%s)", (who.id, data.id))
            current = await (await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s', (who.token_hash,))).fetchone()
        return {'ok': True, 'signedOut': not bool(current)}
