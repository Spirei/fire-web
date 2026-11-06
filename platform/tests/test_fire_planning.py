from datetime import datetime
from zoneinfo import ZoneInfo


async def test_fire_history_cannot_be_overwritten_and_get_is_owned(client, admin, db):
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year - 1
    assert (await client.get("/api/fire-settings")).json() == {"fire": {}, "revision": 0}
    data = {
        "fire": {"tableRows": [{"year": year, "assets": 12}]},
        "assetRecord": {"amountBase": 100, "amountUsd": 14, "currency": "CNY"},
    }
    first = await save_fire(client, json=data)
    assert first.status_code == 200, first.text
    result = await save_fire(
        client,
        json={"fire": {"tableRows": [{"year": year, "assets": 999, "target": 33}], "assetHistory": []}},
    )
    assert result.status_code == 200, result.text
    assert result.json()["assetHistory"] == first.json()["assetHistory"]
    saved = (await client.get("/api/fire-settings")).json()["fire"]
    assert saved["tableRows"] == [{"year": year, "assets": 12, "target": 33}]
    assert (
        await save_fire(
            client,
            json={"fire": {}, "assetRecord": {"amountBase": 0, "amountUsd": 1, "currency": "USD"}},
        )
    ).status_code == 400
    assert (await client.get("/api/fire-settings")).json()["fire"] == saved


import asyncio

import pytest
from alcor_api.cli import create_user
from alcor_api.native_app_auth import issue_grant


async def token(db, owner, scope):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, scope, "Synthetic FIRE client")
    return {"authorization": "Bearer " + pair["access_token"]}


@pytest.mark.parametrize("version", [1, 2])
async def test_native_fire_shapes_scopes_owner_and_pure_get(client, admin, db, settings, version):
    headers = await token(db, admin, "portfolio.read portfolio.write")
    path = f"/api/v{version}/fire-settings"
    result = await client.put(path, json={"fire": {"target": 120}}, headers=headers)
    assert result.status_code == 200, result.text
    value = result.json()["data"] if version == 2 else result.json()
    assert value == {"ok": True, "assetHistory": []}
    before = await client.get(path, headers=headers)
    assert before.status_code == 200, before.text
    value = before.json()["data"] if version == 2 else before.json()
    assert value == {"fire": {"target": 120, "assetHistory": []}}
    read = await token(db, admin, "portfolio.read")
    assert (await client.put(path, json={"fire": {}}, headers=read)).status_code == 403
    other = await create_user(settings, "OtherFireUser", "SyntheticOtherFire9")
    other_headers = await token(db, other, "portfolio.read")
    response = await client.get(path, headers=other_headers)
    assert (response.json()["data"] if version == 2 else response.json()) == {"fire": {}}
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT owner_id,revision FROM fire_planning_settings")).fetchall()
        assert rows == [{"owner_id": admin, "revision": 1}]


async def test_concurrent_fire_saves_retain_both_manual_observations(client, admin):
    from uuid import uuid4

    async def save(amount, revision=None):
        return await save_fire(
            client,
            json={
                **({"requestId": str(uuid4()), "expectedRevision": revision} if revision is not None else {}),
                "fire": {"target": amount},
                "assetRecord": {"amountBase": amount, "amountUsd": amount, "currency": "USD"},
            },
        )

    results = await asyncio.gather(save(101, 0), save(202, 0))
    assert sorted(r.status_code for r in results) == [200, 409]
    rejected_index = next(i for i, r in enumerate(results) if r.status_code == 409)
    # A definite conflict can be resubmitted explicitly after reading the new revision.
    assert (await save([101, 202][rejected_index])).status_code == 200
    stored = (await client.get("/api/fire-settings")).json()["fire"]
    assert sorted(x["amountUsd"] for x in stored["assetHistory"]) == [101, 202]
    assert stored["target"] in (101, 202)


@pytest.mark.parametrize("failure_table", ["fire_planning_settings", "audit_events"])
async def test_fire_failed_save_keeps_prior_plan_and_observations(client, admin, db, failure_table):
    initial = await save_fire(client, json={"fire": {"target": 33}})
    assert initial.status_code == 200
    before = (await client.get("/api/fire-settings")).json()
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_synthetic_fire_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_synthetic_fire_write BEFORE INSERT OR UPDATE ON "
            + failure_table
            + " FOR EACH ROW EXECUTE FUNCTION reject_synthetic_fire_write()"
        )
    failed = await save_fire(
        client,
        json={"fire": {"target": 99}, "assetRecord": {"amountBase": 10, "amountUsd": 10, "currency": "USD"}},
    )
    assert failed.status_code >= 500
    assert (await client.get("/api/fire-settings")).json() == before
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT revision FROM fire_planning_settings WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["revision"] == 1


def test_actual_old_history_filter_and_amount_boundaries_match():
    import json
    import os
    import subprocess
    from pathlib import Path

    from alcor_api.fire_planning import CURRENCIES, asset_history, valid_amount

    root = os.environ.get("ALCOR_FIRE_LEGACY_ROOT")
    if not root:
        pytest.skip("Explicit readonly legacy source root required")
    history = [
        {"recordedAt": "2025-02-01T00:00:00Z", "amountBase": 12, "amountUsd": 2, "currency": "CNY"},
        {"recordedAt": "2025-01-01T00:00:00Z", "amountBase": 14, "amountUsd": 2, "currency": "HKD"},
        {"recordedAt": "invalid", "amountBase": 1, "amountUsd": 1, "currency": "USD"},
        {"recordedAt": "2025-01-01T00:00:00Z", "amountBase": 0, "amountUsd": 1, "currency": "USD"},
    ]
    amounts = [
        [1, 1, "USD"],
        [10**15, 10**15, "CNY"],
        [10**15 + 1, 1, "USD"],
        [-1, 1, "USD"],
        [1, 0, "USD"],
        [1, 1, "UNKNOWN"],
    ]
    result = subprocess.run(
        ["node", str(Path(__file__).parent / "fire_candidate/old-history.cjs")],
        input=json.dumps({"amounts": amounts, "history": history}),
        text=True,
        capture_output=True,
        check=True,
    )
    old = json.loads(result.stdout)
    assert old["history"] == asset_history(history)
    assert old["amounts"] == [valid_amount(a) and valid_amount(b) and c in CURRENCIES for a, b, c in amounts]


async def test_fire_changes_emit_real_settings_watermark_and_identical_save_is_silent(client, admin, db):
    initial = (await client.get("/api/account/changes")).json()["domains"]["settings"]["revision"]
    data = {"fire": {"target": 555}}
    assert (await save_fire(client, json=data)).status_code == 200
    changed = (await client.get("/api/account/changes")).json()["domains"]["settings"]["revision"]
    assert changed == initial + 1
    assert (await save_fire(client, json=data)).status_code == 200
    assert (await client.get("/api/account/changes")).json()["domains"]["settings"]["revision"] == changed
    async with db.connection() as conn:
        events = await (
            await conn.execute(
                "SELECT source_table,operation FROM account_change_events WHERE owner_id=%s AND source_table='fire_planning_settings'",
                (admin,),
            )
        ).fetchall()
        assert events == [{"source_table": "fire_planning_settings", "operation": "INSERT"}]


async def test_omitting_frozen_year_cannot_delete_its_snapshot(client, admin):
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year - 1
    assert (
        await save_fire(
            client,
            json={"fire": {"tableRows": [{"year": year, "original": 100, "current": 123}]}},
        )
    ).status_code == 200
    assert (await save_fire(client, json={"fire": {"target": 44, "tableRows": []}})).status_code == 200
    saved = (await client.get("/api/fire-settings")).json()["fire"]
    assert saved["tableRows"] == [{"year": year, "original": 100, "current": 123}]


async def test_fire_original_uuid_and_cas_prevent_duplicate_observation(client, admin, db):
    from uuid import uuid4

    key = str(uuid4())
    data = {
        "requestId": key,
        "expectedRevision": 0,
        "fire": {"target": 9},
        "assetRecord": {"amountBase": 3, "amountUsd": 3, "currency": "USD"},
    }
    first = await save_fire(client, json=data)
    assert first.status_code == 200, first.text
    assert first.json()["state"] == "completed" and first.json()["revision"] == 1
    assert (await save_fire(client, json=data)).json() == first.json()
    assert (await client.get("/api/fire-settings/operations/" + key)).json() == first.json()
    assert (await save_fire(client, json={**data, "fire": {"target": 8}})).status_code == 409
    a = {**data, "requestId": str(uuid4()), "expectedRevision": 1}
    b = {**a, "requestId": str(uuid4())}
    responses = await asyncio.gather(save_fire(client, json=a), save_fire(client, json=b))
    assert sorted(r.status_code for r in responses) == [200, 409]
    state = (await client.get("/api/fire-settings")).json()
    assert state["revision"] == 2 and len(state["fire"]["assetHistory"]) == 2
    from psycopg.errors import CheckViolation

    async with db.connection() as conn:
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE fire_planning_operations SET result='{}'::jsonb WHERE owner_id=%s AND request_id=%s",
                    (admin, key),
                )
    assert (await client.get("/api/fire-settings/operations/" + key)).json() == first.json()

    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM fire_planning_operations WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 2


async def test_fire_receipt_failure_rolls_back_asset_and_change_watermark(client, admin, db):
    from uuid import uuid4

    key = str(uuid4())
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_fire_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_fire_receipt BEFORE INSERT ON fire_planning_operations FOR EACH ROW EXECUTE FUNCTION reject_fire_receipt()"
        )
    data = {
        "requestId": key,
        "expectedRevision": 0,
        "fire": {},
        "assetRecord": {"amountBase": 3, "amountUsd": 3, "currency": "USD"},
    }
    assert (await save_fire(client, json=data)).status_code >= 500
    assert (await client.get("/api/fire-settings")).json() == {"fire": {}, "revision": 0}
    assert (await client.get("/api/fire-settings/operations/" + key)).status_code == 404
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_change_events WHERE owner_id=%s AND source_table='fire_planning_settings'",
                (admin,),
            )
        ).fetchone()


@pytest.mark.parametrize("original_currency", ["CNY", None])
async def test_frozen_fire_years_keep_original_currency_or_unknown(client, admin, original_currency):
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year - 1
    fire = {"tableRows": [{"year": year, "current": 123}]}
    if original_currency:
        fire["baseCurrency"] = original_currency
    assert (await save_fire(client, json={"fire": fire})).status_code == 200
    response = await save_fire(client, json={"fire": {"baseCurrency": "USD", "tableRows": []}})
    assert response.status_code == 200
    saved = (await client.get("/api/fire-settings")).json()["fire"]
    assert saved.get("baseCurrency") == original_currency
    assert saved["tableRows"] == fire["tableRows"]


async def save_fire(client, *, json):
    from uuid import uuid4

    body = dict(json)
    if "requestId" not in body:
        body["requestId"] = str(uuid4())
        body["expectedRevision"] = (await client.get("/api/fire-settings")).json()["revision"]
    return await client.put("/api/fire-settings", json=body)


async def test_canonical_fire_missing_command_identity_cannot_bypass_cas(client, admin, db):
    result = await client.request("PUT", "/api/fire-settings", json={"fire": {"target": 12}})
    assert result.status_code == 400
    assert (await client.get("/api/fire-settings")).json() == {"fire": {}, "revision": 0}
