import asyncio

import pytest
from alcor_api.accounts import insert_account
from alcor_api.cli import create_user
from alcor_api.identity_import import import_trial_snapshot
from psycopg.conninfo import conninfo_to_dict
from test_identity_import import snapshot


async def test_formal_uid_starts_at_one_and_test_accounts_do_not_consume_numbers(client, settings, db):
    test = await create_user(settings, "SyntheticTest", "Synthetic9Pass", role="admin", is_test=True)
    first = await create_user(settings, "FirstReal", "Synthetic9Pass", role="user")
    await create_user(settings, "AnotherTest", "Synthetic9Pass", role="user", is_test=True)
    second = await create_user(settings, "SecondReal", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT id,uid,is_test FROM users")).fetchall()
        by_id = {r["id"]: r for r in rows}
        assert by_id[test]["is_test"] and by_id[test]["uid"] is None
        assert by_id[first]["uid"] == "1" and by_id[second]["uid"] == "2"
        assert (await (await conn.execute("SELECT last_uid FROM account_uid_state")).fetchone())[
            "last_uid"
        ] == 2


async def test_uid_allocation_rolls_back_and_concurrent_formal_accounts_remain_unique(db, settings):
    with pytest.raises(RuntimeError):
        async with db.connection() as conn, conn.transaction():
            await insert_account(conn, "RolledBack", "SyntheticHash", role="admin")
            raise RuntimeError("abort synthetic transaction")
    await asyncio.gather(
        *(
            create_user(settings, "Numeric" + str(i), "Synthetic9Pass", role="user", is_test=i % 2 == 1)
            for i in range(8)
        )
    )
    async with db.connection() as conn:
        rows = await (
            await conn.execute("SELECT uid FROM users WHERE NOT is_test ORDER BY uid::bigint")
        ).fetchall()
        assert [r["uid"] for r in rows] == ["1", "2", "3", "4"]


async def test_snapshot_import_preserves_test_classification_without_assigning_formal_uid(db, settings):
    data, _ = snapshot()
    data["users"][0]["is_test"] = True
    await import_trial_snapshot(
        db,
        data,
        source_key=b"SyntheticIdentityKey9",
        expected_database=conninfo_to_dict(settings.database_url.get_secret_value())["dbname"],
    )
    first = await create_user(settings, "FormalAfterImport", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        original = await (
            await conn.execute("SELECT uid,is_test FROM users WHERE id='source-user-001'")
        ).fetchone()
        assert original["is_test"] and original["uid"] is None
        assert (await (await conn.execute("SELECT uid FROM users WHERE id=%s", (first,))).fetchone())[
            "uid"
        ] == "1"


async def test_directory_numeric_order_and_pagination_keep_test_accounts_after_formal(
    client, admin, settings
):
    await create_user(settings, "Zebra", "Synthetic9Pass", role="user")
    await create_user(settings, "EarlierTest", "Synthetic9Pass", role="user", is_test=True)
    await create_user(settings, "Alpha", "Synthetic9Pass", role="user")
    rows = []
    cursor = None
    while True:
        response = await client.get(
            "/api/users", params={"limit": 2, **({"cursor": cursor} if cursor else {})}
        )
        assert response.status_code == 200, response.text
        data = response.json()
        rows.extend(data["items"])
        cursor = data["next_cursor"]
        if not cursor:
            break
    assert [r["uid"] for r in rows] == ["1", "2", "3", None]
    assert rows[-1]["is_test"]
