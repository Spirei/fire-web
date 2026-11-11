"""The existing source-owner lock order without creating financial collections on GET."""

from fastapi import HTTPException

from .broker_accounts import serialize_brokers
from .security import lock_read_identity


async def source_read_lock(conn, who):
    # Same identity-management -> broker-accounts -> current user/session order
    # as the old Cash/Trading lock; history reads need no financial row bootstrap.
    await serialize_brokers(conn, who.id)
    await lock_read_identity(conn, who, require_admin=False)
    row = await (await conn.execute('SELECT active,role FROM users WHERE id=%s', (who.id,))).fetchone()
    if not row or not row['active'] or row['role'] != who.role:
        raise HTTPException(403, '账号权限已变化', headers={'X-Alcor-Retire-Context': 'true'})
