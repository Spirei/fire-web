import asyncio
from uuid import uuid4

import psycopg
import pytest
from alcor_api.cli import create_user
from psycopg import AsyncConnection
from test_account_admin import body_for, login

P = "/api/users/receipts"


async def close(client, identifier):
    return await client.post(P + "/" + identifier + "/close", json={"expected_kind": "account-action"})


async def test_closed_unknown_uuid_blocks_late_profile_delete_and_both_credential_actions(
    client, admin, settings, db
):
    target = await create_user(settings, "ClosurePeer", "Synthetic9Pass", role="user")
    data = await body_for(client, target, role="admin")
    identifier = data["request_id"]
    closed = await close(client, identifier)
    assert closed.status_code == 200, closed.text
    result = {"request_id": identifier, "closed": True, "executed": False}
    assert closed.json() == result
    assert (await close(client, identifier)).json() == result
    requests = [
        ("PATCH", "/api/users/" + target, data),
        (
            "DELETE",
            "/api/users/" + target,
            {k: data[k] for k in ("request_id", "revision", "current_password")},
        ),
        (
            "POST",
            "/api/users/" + target + "/reset-password",
            {k: data[k] for k in ("request_id", "revision", "current_password")}
            | {"new_password": "DifferentSynthetic9Pass"},
        ),
        (
            "POST",
            "/api/users/" + target + "/disable-totp",
            {k: data[k] for k in ("request_id", "revision", "current_password")},
        ),
    ]
    async with db.connection() as conn:
        before = await (await conn.execute("SELECT * FROM users WHERE id=%s", (target,))).fetchone()
    for method, path, body in requests:
        response = await client.request(method, path, json=body)
        assert response.status_code == 409 and "已关闭" in response.text, response.text
    assert (await client.get(P + "/" + identifier)).json() == result
    async with db.connection() as conn:
        after = await (await conn.execute("SELECT * FROM users WHERE id=%s", (target,))).fetchone()
        assert before == after
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (admin, identifier),
                )
            ).fetchone()
        )["n"] == 1
        with pytest.raises(psycopg.DatabaseError):
            async with conn.transaction():
                await conn.execute(
                    "DELETE FROM account_actions WHERE owner_id=%s AND request_id=%s", (admin, identifier)
                )


async def test_close_races_late_original_under_same_global_admission_lock(
    client, admin, settings, db, monkeypatch
):
    target = await create_user(settings, "ClosurePeer", "Synthetic9Pass", role="user")
    data = await body_for(client, target, role="admin")
    entered, release = asyncio.Event(), asyncio.Event()
    original = AsyncConnection.execute

    async def paused(conn, query, *args, **kwargs):
        if isinstance(query, str) and "INSERT INTO account_actions" in query and "result,closed" in query:
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
        return await original(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", paused)
        closing = asyncio.create_task(close(client, data["request_id"]))
        await asyncio.wait_for(entered.wait(), 5)
        late = asyncio.create_task(client.patch("/api/users/" + target, json=data))
        await asyncio.sleep(0)
        assert not late.done()
        release.set()
        result, blocked = await asyncio.gather(closing, late)
    assert result.status_code == 200 and result.json()["executed"] is False
    assert blocked.status_code == 409 and "已关闭" in blocked.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT role FROM users WHERE id=%s", (target,))).fetchone())[
            "role"
        ] == "user"


async def test_inflight_original_wins_close_and_duplicate_close_never_changes_receipt(
    client, admin, settings, db, monkeypatch
):
    target = await create_user(settings, "ClosurePeer", "Synthetic9Pass", role="user")
    data = await body_for(client, target, role="admin")
    entered, release = asyncio.Event(), asyncio.Event()
    original = AsyncConnection.execute

    async def paused(conn, query, *args, **kwargs):
        if isinstance(query, str) and "INSERT INTO account_actions" in query and "result,closed" not in query:
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
        return await original(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", paused)
        changing = asyncio.create_task(client.patch("/api/users/" + target, json=data))
        await asyncio.wait_for(entered.wait(), 5)
        closing = asyncio.create_task(close(client, data["request_id"]))
        await asyncio.sleep(0)
        assert not closing.done()
        release.set()
        applied, first = await asyncio.gather(changing, closing)
    assert applied.status_code == 200, applied.text
    second = await close(client, data["request_id"])
    assert first.json() == second.json() == applied.json()
    assert (await client.get(P + "/" + data["request_id"])).json() == applied.json()


async def test_close_and_audit_are_atomic_and_failed_admission_can_be_closed_later(
    client, admin, db, monkeypatch
):
    identifier = str(uuid4())
    original = AsyncConnection.execute

    async def fail_audit(conn, query, *args, **kwargs):
        if isinstance(query, str) and "'account.operation.closed'" in query:
            raise RuntimeError("Synthetic rollback after tombstone insert")
        return await original(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", fail_audit)
        assert (await close(client, identifier)).status_code == 503
    assert (await client.get(P + "/" + identifier)).status_code == 404
    assert (await close(client, identifier)).json()["executed"] is False


async def test_history_keyset_owner_scope_current_admin_and_read_purity(client, app, admin, settings, db):
    peer_id = await create_user(settings, "OtherClosureAdmin", "Synthetic9Pass", role="admin")
    peer = await login(app, "OtherClosureAdmin")
    other = str(uuid4())
    assert (await close(peer, other)).status_code == 200
    own = [str(uuid4()) for _ in range(3)]
    for identifier in own:
        assert (await close(client, identifier)).status_code == 200
    async with db.connection() as conn:
        before = await (
            await conn.execute(
                "SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY owner_id,request_id)::text) digest FROM account_actions a"
            )
        ).fetchone()
    page = await client.get(P, params={"limit": 2})
    assert page.status_code == 200, page.text
    first = page.json()
    rest = (await client.get(P, params={"limit": 2, "after": first["next_after"]})).json()
    ids = [v["request_id"] for v in first["items"] + rest["items"]]
    assert set(ids) == set(own) and len(ids) == 3 and rest["next_after"] is None
    assert (await client.get(P, params={"after": other})).status_code == 404
    assert (await client.get(P + "/" + other)).status_code == 404
    assert len((await peer.get(P)).json()["items"]) == 1
    async with db.connection() as conn:
        after = await (
            await conn.execute(
                "SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY owner_id,request_id)::text) digest FROM account_actions a"
            )
        ).fetchone()
        assert before == after
        await conn.execute(
            "UPDATE users SET role='user',session_version=session_version+1 WHERE id=%s", (peer_id,)
        )
    assert (await peer.get(P)).status_code in (401, 403)
    assert (await close(peer, str(uuid4()))).status_code in (401, 403)
    await peer.aclose()


async def test_real_receipts_and_history_decode_in_actual_web_parser(client, admin, settings, tmp_path):
    import json
    import shutil
    import subprocess

    from alcor_api.config import ROOT

    target = await create_user(settings, "ClosurePeer", "Synthetic9Pass", role="user")
    data = await body_for(client, target, role="admin")
    applied = await client.patch("/api/users/" + target, json=data)
    assert applied.status_code == 200, applied.text
    identifier = str(uuid4())
    closed = await close(client, identifier)
    history = await client.get(P)
    payload = {"history": history.json(), "closed": closed.json(), "applied": applied.json()}
    path = tmp_path / "actual-receipts.json"
    path.write_text(json.dumps(payload))
    assert "Synthetic9Pass" not in path.read_text()
    script = r"""
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import {pathToFileURL} from 'node:url';
      const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      const m=await import(pathToFileURL(process.argv[2]).href);
      const page=m.accountActionHistory(d.history); assert.equal(page.items.length,2);
      assert.equal(m.accountOutcome(d.applied,d.applied.request_id),'账号已更新');
      assert.equal(m.accountOutcome(d.closed,d.closed.request_id),'已关闭，未执行');
      m.closedAccountReceipt(d.closed,d.closed.request_id);
      assert.throws(()=>m.closedAccountReceipt({...d.closed,executed:true},d.closed.request_id));
      assert.throws(()=>m.closedAccountReceipt(d.closed,d.applied.request_id));
      assert.throws(()=>m.accountActionHistory({...d.history,items:[...d.history.items,...d.history.items]}));
      assert.throws(()=>m.accountActionHistory({...d.history,next_after:d.history.items[0].request_id}));
    """
    result = await asyncio.to_thread(
        subprocess.run,
        [
            shutil.which("node"),
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
            str(path),
            str(ROOT / "tests/fixtures/former-web-protocol/account-action-state.ts"),
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
