"""Explicit legacy URL editing over the existing sealed FX authority."""
import asyncio
import hashlib
import ipaddress
from urllib.parse import urlsplit

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import digest


async def prepare(db, conn, who, url, password, code, verifier):
    if not password or verifier is None:
        raise HTTPException(403, "保存汇率来源需要管理员验证")
    checked = await verifier.step_up(conn, who, password, code)
    try:
        parsed = urlsplit(url)
        if (not isinstance(url, str) or len(url) > 2048 or any(c.isspace() for c in url)
                or parsed.scheme != 'https' or not parsed.hostname
                or parsed.username or parsed.password or parsed.fragment):
            raise ValueError()
        port = parsed.port or 443
        from .fx_provider_transport import resolve
        async with asyncio.timeout(5):
            addresses = await resolve(parsed.hostname, port)
        if not addresses or len(addresses) > 32 or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise ValueError()
    except (ValueError, TypeError, TimeoutError, OSError):
        raise HTTPException(422, "请填写可访问的公网 HTTPS 汇率地址") from None
    target = [parsed.scheme, parsed.hostname, port, parsed.path or '/']
    approval = {'target': target, 'addresses': addresses, 'allow_plaintext': False}
    entry = {'id': 'fx-settings-' + hashlib.sha256(who.id.encode()).hexdigest()[:24], **approval}
    custom = {'url': url, 'approval': approval}
    if parsed.hostname == 'openexchangerates.org':
        custom.update(time_field='timestamp', time_precision='epoch_seconds')
    await conn.execute(
        "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) "
        "VALUES(%s,'reference-reauth',%s,%s,%s,clock_timestamp()+interval '15 minutes') "
        "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at",
        (digest('reference-reauth:' + who.token_hash), who.id, who.token_hash,
         Jsonb({'session_version': checked['session_version']})),
    )
    return entry, custom, checked


async def apply(db, conn, who, custom, targets, expected_revision):
    from .fx_service import ManagedFx
    from .market_worker import Bound
    effective = db.settings.model_copy(update={'fx_provider_targets': targets})
    current = await (await conn.execute('SELECT revision,daily_budget FROM fx_config WHERE singleton FOR UPDATE')).fetchone()
    revision = await ManagedFx(Bound(conn, effective)).configure(
        who, True, current['daily_budget'], expected_revision, custom,
    )
    return {'authority': 'fx-provider', 'revision': revision, 'collection': 'explicit_refresh_required'}
