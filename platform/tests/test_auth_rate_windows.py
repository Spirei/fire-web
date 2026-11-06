import asyncio

from alcor_api.main import rate_limit
from alcor_api.security import digest


async def test_minute_passkey_budget_resets_without_resetting_fifteen_minute_account_budget(db):
    minute = digest('synthetic-passkey-options-ip-minute')
    account = digest('synthetic-identity-manage-user')
    assert await rate_limit(db, minute, 1, window_seconds=60)
    assert await rate_limit(db, account, 1)
    assert not await rate_limit(db, minute, 1, window_seconds=60)
    assert not await rate_limit(db, account, 1)
    async with db.connection() as conn:
        await conn.execute("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds'")
    assert await rate_limit(db, minute, 1, window_seconds=60)
    assert not await rate_limit(db, account, 1)
    async with db.connection() as conn:
        counts = await (await conn.execute('SELECT bucket,attempts FROM auth_rate_limits')).fetchall()
    assert {row['bucket']: row['attempts'] for row in counts} == {minute: 1, account: 3}


async def test_concurrent_anonymous_budget_is_atomic_and_cannot_borrow_another_browser_budget(db):
    key = digest('synthetic-passkey-browser-one')
    results = await asyncio.gather(*(rate_limit(db, key, 5) for _ in range(12)))
    assert sum(results) == 5
    assert not await rate_limit(db, key, 5)
    assert await rate_limit(db, digest('synthetic-passkey-browser-two'), 5)
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT attempts FROM auth_rate_limits WHERE bucket=%s', (key,))).fetchone()
    assert row['attempts'] == 13
