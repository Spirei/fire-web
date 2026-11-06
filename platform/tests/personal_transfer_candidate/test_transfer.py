"""Focused isolated-PG/API vectors, queued for the shared validation batch.

The session pg/settings fixtures verify the fresh local data directory and database
identity. No Agent, provider, SMTP or production connection is used by these cases.
"""

import hashlib
import json
from datetime import datetime
from decimal import Decimal
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
from alcor_api.cli import create_user
from test_cash_ledger import account

ROOT = "/api/personal-data-transfer"


def payload(data):
    return {"format": "fire-site-backup", "version": 2, "data": data}


def record(identifier="old-record", code="SYNTH"):
    return {
        "id": identifier,
        "name": "Synthetic transfer record",
        "code": code,
        "market": "US",
        "price": None,
        "cost": None,
        "qty": "0",
        "group_name": "",
        "note": "Synthetic source declaration",
        "source": "manual",
        "watch_group_id": "",
        "updated_at": "2026-01-02T00:00:00Z",
    }


async def preview(client, data, mappings=None, *, identifier=None, text=None):
    identifier = identifier or str(uuid4())
    response = await client.post(
        ROOT + "/preview",
        json={
            "requestId": identifier,
            "payloadText": text if text is not None else json.dumps(payload(data), ensure_ascii=False),
            "mappings": mappings or {},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def confirm(client, prepared):
    return await client.post(
        ROOT + "/submit",
        json={"requestId": prepared["requestId"], "previewId": prepared["previewId"]},
    )


async def test_original_utf8_and_sha_are_exact_and_unreadable_by_other_owner(
    client, admin, settings, app, db
):
    raw = '{\n  "format": "fire-site-backup", "version": 2,\n  "data": {"profile": {"nickname": "原文留存"}}\n}\n'
    prepared = await preview(client, {}, text=raw)
    assert prepared["confirmSupported"] and not prepared["blocked"]
    original = await client.get(ROOT + "/originals/" + prepared["sourceId"])
    assert original.status_code == 200
    assert original.content == raw.encode("utf-8")
    assert original.headers["x-alcor-sha256"] == hashlib.sha256(raw.encode()).hexdigest()
    assert "no-store" in original.headers["cache-control"]
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM personal_data_transfer_before_images WHERE owner_id=%s", (admin,))
        ).fetchone()
    await create_user(settings, "SyntheticTransferOther", "SyntheticOtherTransfer9", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login",
            json={"login": "SyntheticTransferOther", "password": "SyntheticOtherTransfer9"},
        )
        assert login.status_code == 200, login.text
        other.headers["x-csrf-token"] = login.json()["csrf"]
        for suffix in ("/originals/" + prepared["sourceId"], "/operations/" + prepared["requestId"]):
            response = await other.get(ROOT + suffix)
            assert response.status_code == 404, response.text
            assert "原文留存" not in response.text


async def test_original_uuid_replay_close_and_close_before_late_preview(client, admin, db):
    prepared = await preview(client, {"profile": {"nickname": "Imported nickname"}})
    first = await confirm(client, prepared)
    assert first.status_code == 200, first.text
    replay = await confirm(client, prepared)
    assert replay.status_code == 200 and replay.json() == first.json()
    closed = await client.post(ROOT + "/operations/" + prepared["requestId"] + "/close", json={})
    assert closed.status_code == 200 and closed.json() == first.json()
    before = await client.get(ROOT + "/before-images/" + prepared["requestId"])
    assert before.status_code == 200
    assert hashlib.sha256(before.content).hexdigest() == first.json()["beforeImageSha256"]
    late_id = str(uuid4())
    close = await client.post(ROOT + "/operations/" + late_id + "/close", json={})
    assert close.status_code == 200 and close.json()["executed"] is False
    late = await preview(client, {"records": [record()]}, identifier=late_id)
    assert late == close.json() and late["state"] == "closed"
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM personal_data_transfer_sources WHERE owner_id=%s AND request_id=%s",
                (admin, late_id),
            )
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM portfolio_records WHERE owner_id=%s", (admin,))
        ).fetchone()


async def test_fire_import_preserves_exact_amounts_and_distinct_same_time_observations(client, admin, db):
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year - 1
    instant = "2025-01-02T03:04:05+08:00"
    # JSON numeric literals deliberately exceed binary-float precision. The API
    # accepts the file text, and the PG read below also decodes numeric as Decimal.
    fire_text = (
        '{"baseCurrency":"USD","tableRows":[{"year":' + str(year)
        + ',"current":"123.000000000000001"}],"assetHistory":['
        + '{"recordedAt":"' + instant
        + '","amountBase":123.000000000000001,"amountUsd":123.000000000000001,"currency":"USD"},'
        + '{"recordedAt":"' + instant
        + '","amountBase":123.000000000000002,"amountUsd":123.000000000000002,"currency":"USD"}]}'
    )
    prepared = await preview(client, {"userSettings": [{"user_id": admin, "fire": fire_text}]}, {"sourceOwnerId": admin})
    assert prepared["confirmSupported"], prepared
    response = await confirm(client, prepared)
    assert response.status_code == 200, response.text
    replay = await confirm(client, prepared)
    assert replay.status_code == 200 and replay.json() == response.json()
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT value::text AS original FROM fire_planning_settings WHERE owner_id=%s", (admin,))
        ).fetchone()
    saved = json.loads(row["original"], parse_float=Decimal)
    observations = saved["assetHistory"]
    assert len(observations) == 2
    assert [item["recordedAt"] for item in observations] == [instant, instant]
    assert [Decimal(str(item["amountBase"])) for item in observations] == [
        Decimal("123.000000000000001"), Decimal("123.000000000000002")
    ]
    assert all(item["currency"] == "USD" and "id" not in item for item in observations)
    assert saved["tableRows"] == [{"year": year, "current": "123.000000000000001"}]


async def test_parent_revision_conflict_cannot_apply_any_imported_record(client, admin, db):
    prepared = await preview(client, {"records": [record()]})
    assert prepared["confirmSupported"], prepared
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET revision=%s WHERE id=%s", (uuid4(), admin))
    response = await confirm(client, prepared)
    assert response.status_code == 409, response.text
    async with db.connection() as conn:
        for table in ("portfolio_records", "personal_data_transfer_before_images", "personal_data_transfer_operations"):
            assert not await (await conn.execute(f"SELECT 1 FROM {table} WHERE owner_id=%s", (admin,))).fetchone()


async def test_receipt_failure_rolls_back_records_funds_cash_and_before_image(client, admin, db):
    account_id = await account(client, name="Synthetic transfer cash")
    source = record()
    source["user_id"] = admin
    funding = {
        "id": "old-opening", "user_id": admin, "currency": "USD", "type": "opening",
        "amount": "100.000000000000001", "direction": 1, "note": "Synthetic verified opening",
        "occurred_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
    }
    mapping = {
        "mode": "mapped-domain-import", "sourceOwnerId": admin,
        "accounts": {source["id"]: {"accountId": account_id, "accountKind": "real"}},
        "funds": {funding["id"]: {"accountId": account_id, "accountKind": "real", "openingBasis": "new_external_opening"}},
    }
    prepared = await preview(client, {"records": [source], "fundTransactions": [funding]}, mapping)
    assert prepared["confirmSupported"], prepared
    assert prepared["fundPreviews"][0]["view"]["delta"] == "100.000000000000001"
    tables = ("portfolio_records", "portfolio_record_operations", "fund_sources", "cash_ledger_entries", "cash_ledger_operations", "personal_data_transfer_before_images", "personal_data_transfer_operations")
    async with db.connection() as conn:
        # Rollback-only preview itself must leave no financial effects or child receipts.
        for table in tables:
            assert not await (await conn.execute(f"SELECT 1 FROM {table} WHERE owner_id=%s", (admin,))).fetchone()
        await conn.execute("CREATE SEQUENCE synthetic_transfer_receipt_reached")
        await conn.execute("CREATE FUNCTION reject_synthetic_transfer_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_transfer_receipt_reached'); RAISE EXCEPTION 'synthetic parent receipt failure'; END $$")
        await conn.execute("CREATE TRIGGER reject_synthetic_transfer_receipt BEFORE INSERT ON personal_data_transfer_operations FOR EACH ROW EXECUTE FUNCTION reject_synthetic_transfer_receipt()")
    failed = await confirm(client, prepared)
    assert failed.status_code >= 500, failed.text
    async with db.connection() as conn:
        reached = await (await conn.execute("SELECT is_called FROM synthetic_transfer_receipt_reached")).fetchone()
        assert reached["is_called"]  # Proves this was the final receipt failure, not an earlier error.
        for table in tables:
            assert not await (await conn.execute(f"SELECT 1 FROM {table} WHERE owner_id=%s", (admin,))).fetchone()
        original = await (await conn.execute("SELECT sha256 FROM personal_data_transfer_sources WHERE owner_id=%s AND id=%s", (admin, prepared["sourceId"]))).fetchone()
        assert original  # The uploaded original remains, unlike rolled-back financial effects.
