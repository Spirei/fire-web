import asyncio
from datetime import UTC
from uuid import uuid4

import pytest
from alcor_api.cli import create_user
from alcor_api.watchlists import WatchGroups
from fastapi import HTTPException


async def owner(settings, name="WatchOwner"):
    return await create_user(settings, name, "Synthetic9Pass", email=name.lower() + "@example.invalid")


@pytest.mark.asyncio
async def test_explicit_market_seed_is_atomic_and_reads_are_owner_isolated(settings, db):
    first, second = await owner(settings), await owner(settings, "WatchOther")
    groups = WatchGroups(db)
    empty = await groups.list(first)
    assert empty == {"groups": [], "revision": 0, "initialized": False}
    request = uuid4()
    initialized = await asyncio.gather(*(groups.mutate(first, "initialize", {}, request, 0) for _ in range(5)))
    assert all(result == initialized[0] for result in initialized)
    results = await asyncio.gather(*(groups.list(first) for _ in range(5)))
    assert all(r == results[0] for r in results)
    assert len(results[0]["groups"]) == 6
    assert results[0]["revision"] == 1
    assert {r["market"] for r in results[0]["groups"]} == {"US", "HK", "CN", "SG", "JP", "KR"}
    await groups.mutate(second, "initialize", {}, uuid4(), 0)
    other = await groups.list(second)
    assert not {r["id"] for r in results[0]["groups"]} & {r["id"] for r in other["groups"]}
    with pytest.raises(HTTPException) as error:
        await groups.mutate(second, "update", {"id": results[0]["groups"][0]["id"], "name": "Foreign"}, uuid4())
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_create_replay_conflict_and_normalized_uniqueness(settings, db):
    who = await owner(settings)
    groups = WatchGroups(db)
    request = uuid4()
    data = {"name": "  Tech   Stocks  "}
    one, two = await asyncio.gather(groups.mutate(who, "create", data, request), groups.mutate(who, "create", data, request))
    assert one == two == await groups.receipt(who, request)
    assert one["group"]["name"] == "Tech   Stocks"
    assert len((await groups.list(who))["groups"]) == 7
    for value in ({"name": "Other"}, {"name": "tech stocks"}):
        with pytest.raises(HTTPException) as error:
            await groups.mutate(who, "create", value, request if value["name"] == "Other" else uuid4())
        assert error.value.status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM watch_group_operations WHERE owner_id=%s", (who,))).fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_stale_writes_tombstones_and_recreation(settings, db):
    who = await owner(settings)
    groups = WatchGroups(db)
    created = await groups.mutate(who, "create", {"name": "Long Term"}, uuid4())
    group_id = created["group"]["id"]
    updated = await groups.mutate(who, "update", {"id": group_id, "visible": 1}, uuid4(), created["revision"])
    assert updated["group"]["visible"] == 1
    with pytest.raises(HTTPException) as error:
        await groups.mutate(who, "delete", {"id": group_id}, uuid4(), created["revision"])
    assert error.value.status_code == 409
    deleted = await groups.mutate(who, "delete", {"id": group_id}, uuid4(), updated["revision"])
    assert deleted["deleted"]
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT deleted_at,revision FROM watch_groups WHERE owner_id=%s AND id=%s", (who, group_id))).fetchone()
        assert row["deleted_at"] is not None and row["revision"] == deleted["revision"]
    recreated = await groups.mutate(who, "create", {"name": "Long Term"}, uuid4())
    assert recreated["group"]["id"] != group_id
    no_op = await groups.mutate(who, "update", {"id": recreated["group"]["id"]}, uuid4())
    assert no_op["revision"] == recreated["revision"]


@pytest.mark.asyncio
async def test_sort_is_transactional_and_does_not_modify_market_identity(settings, db):
    who = await owner(settings)
    groups = WatchGroups(db)
    await groups.mutate(who, "initialize", {}, uuid4(), 0)
    original = await groups.list(who)
    ids = [g["id"] for g in original["groups"]]
    with pytest.raises(HTTPException):
        await groups.mutate(who, "reorder", {"order": [ids[-1], "foreign"]}, uuid4())
    assert await groups.list(who) == original
    result = await groups.mutate(who, "reorder", {"order": [ids[-1]]}, uuid4(), original["revision"])
    assert result["updated"] == 1
    current = await groups.list(who)
    assert [g["id"] for g in current["groups"]] == ids[-1:] + ids[:-1]
    assert [g["sort"] for g in current["groups"]] == list(range(6))
    with pytest.raises(HTTPException):
        await groups.mutate(who, "delete", {"id": ids[0]}, uuid4())
    with pytest.raises(HTTPException):
        await groups.mutate(who, "update", {"id": ids[0], "market": "HK"}, uuid4())
    assert await groups.list(who) == current


@pytest.mark.asyncio
async def test_failed_receipt_persistence_rolls_back_mutation(settings, db):
    who = await owner(settings)
    groups = WatchGroups(db)
    await groups.mutate(who, "initialize", {}, uuid4(), 0)
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION reject_watch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$")
        await conn.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON watch_group_operations FOR EACH ROW EXECUTE FUNCTION reject_watch_receipt()")
    with pytest.raises(Exception, match="synthetic receipt failure"):
        await groups.mutate(who, "create", {"name": "Must Roll Back"}, uuid4())
    result = await groups.list(who)
    assert len(result["groups"]) == 6 and result["revision"] == 1
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='watch-groups.create'", ())).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_disabled_owner_cannot_mutate_and_utf16_limit(settings, db):
    who = await owner(settings)
    groups = WatchGroups(db)
    for value in ["😀" * 16, "a\x00b", "", 123]:
        with pytest.raises(HTTPException) as error:
            await groups.mutate(who, "create", {"name": value}, uuid4())
        assert error.value.status_code == 400
    good = await groups.mutate(who, "create", {"name": "😀" * 15}, uuid4())
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (who,))
    with pytest.raises(HTTPException) as error:
        await groups.mutate(who, "delete", {"id": good["group"]["id"]}, uuid4())
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_canonical_http_authorization_and_receipt(settings, app, client, admin):
    initial = await client.get("/api/watch-groups")
    assert initial.status_code == 200
    payload = {"requestId": str(uuid4()), "expectedRevision": initial.json()["revision"], "action": "create", "data": {"name": "HTTP Group"}}
    denied = await client.post("/api/watch-groups/operations", json=payload, headers={"x-csrf-token": "wrong"})
    assert denied.status_code == 403
    result = await client.post("/api/watch-groups/operations", json=payload)
    assert result.status_code == 200, result.text
    replay = await client.get("/api/watch-groups/operations/" + payload["requestId"])
    assert replay.json() == result.json()
    cross = await client.post("/api/watch-groups/operations", json=payload, headers={"origin": "https://other.invalid"})
    assert cross.status_code == 403
    client.cookies.clear()
    assert (await client.get("/api/watch-groups")).status_code == 401


@pytest.mark.asyncio
async def test_revoked_session_cannot_commit_after_http_identity_check(settings, app, client, admin):
    from datetime import datetime

    from alcor_api.security import Identity
    service = WatchGroups(app.state.db)
    initial = await service.list(admin)
    fake = Identity(admin, "AdminOne", "admin", "revoked-token", "", datetime.now(UTC))
    with pytest.raises(HTTPException) as error:
        await service.mutate(admin, "create", {"name": "Unauthorized"}, uuid4(), initial["revision"], authorization=fake)
    assert error.value.status_code in {401, 403}
    assert await service.list(admin) == initial
