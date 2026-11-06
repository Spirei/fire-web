"""Actual App HTTP reads compared with frozen old TS and isolated memory SQLite."""

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from test_broker_accounts import create
from test_legacy_devices import bearer, grant


def test_frozen_broker_source_rejects_non_app_headers_and_missing_scopes():
    steps = [
        {"action": "list", "version": 2},
        {"action": "list", "version": 1, "owner": "synthetic", "token": "legacy-session"},
        {"action": "list", "version": 2, "owner": "synthetic", "token": "bearer fat_" + "a" * 43},
        {"action": "list", "version": 2, "owner": "synthetic", "denied": True},
        {"action": "list", "version": 2, "owner": "synthetic", "forbidden": True},
    ]
    run = subprocess.run(
        ["node", str(Path(__file__).with_name("broker_read_source.cjs"))],
        input=json.dumps({"steps": steps}),
        capture_output=True,
        text=True,
        check=True,
    )
    results = json.loads(run.stdout)
    assert [(item["status"], item["body"]["code"], item["body"]["message"]) for item in results] == [
        (401, 40101, "需要有效的 App 连接")
    ] * 3 + [(403, 40301, "连接缺少明确授权的范围"), (403, 40301, "请求来源不受信任")]


@pytest.mark.skipif(
    os.environ.get("ALCOR_BROKER_SWIFT_VERIFY") != "1" or not shutil.which("swiftc"),
    reason="Explicit Swift verification requested separately from constrained PG runs",
)
async def test_actual_frozen_ios_account_decoder_against_http(client, db, admin, tmp_path):
    account = await create(client)
    pair = await grant(db, admin, "portfolio.read")
    source = Path(__file__).parent / "fixtures" / "broker-read-source"
    evidence = json.loads((source / "source-evidence.json").read_text())
    assert (
        hashlib.sha256((source / "AlcorBrokerAccount.swift").read_bytes()).hexdigest()
        == evidence["ios"]["extracted_sha256"]
    )
    binary = tmp_path / "decode"
    await asyncio.to_thread(
        subprocess.run,
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "module-cache"),
            str(source / "AlcorBrokerAccount.swift"),
            str(source / "DecoderSupport.swift"),
            "-o",
            str(binary),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    for version in (1, 2):
        response = await client.get(f"/api/v{version}/broker-accounts", headers=bearer(pair))
        assert response.status_code == 200, response.text
        decoded = await asyncio.to_thread(
            subprocess.run,
            [str(binary), str(version)],
            input=json.dumps(response.json()["data"]),
            text=True,
            capture_output=True,
            check=True,
        )
        assert json.loads(decoded.stdout) == {
            "owner": admin,
            "ids": [account["id"]],
            "revision": 1,
            "holdingSources": ["manual"],
        }


async def test_broker_reads_frozen_source_owner_versions_presets_unknown_currency(client, db, admin):
    source = Path(__file__).parent / "fixtures" / "broker-read-source"
    for name, expected_hash in json.loads((source / "source-evidence.json").read_text())["sha256"].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == expected_hash
    account = await create(client)
    pair = await grant(db, admin, "portfolio.read")
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE broker_accounts SET created_at='2020-01-01T00:00:00Z',updated_at='2020-01-02T00:00:00Z' WHERE id=%s",
            (account["id"],),
        )
        await conn.execute(
            "INSERT INTO portfolio_records(owner_id,id,name,code,market,account_market,broker_account_id) VALUES(%s,'synthetic-source-position','Synthetic position','0001','HK','CN',%s)",
            (admin, account["id"]),
        )
    source_account = {
        "id": account["id"],
        "owner": admin,
        "name": account["name"],
        "providerId": account["provider_id"],
        "currency": "USD",
        "currencies": ["USD", "HKD"],
        "revision": 1,
        "holdingSource": "manual",
        "createdAt": "2020-01-01T00:00:00.000Z",
        "updatedAt": "2020-01-02T00:00:00.000Z",
    }
    steps = []
    for version in (1, 2):
        steps.extend(
            [
                {"owner": admin, "action": "list", "version": version},
                {"owner": admin, "action": "account", "id": account["id"], "version": version},
                {"owner": admin, "action": "presets", "version": version},
                {"owner": admin, "action": "account", "id": "ba-" + "f" * 24, "version": version},
                {"owner": admin, "action": "list", "version": version, "query": "?bad=1"},
            ]
        )
    run = await asyncio.to_thread(
        subprocess.run,
        ["node", str(Path(__file__).with_name("broker_read_source.cjs"))],
        input=json.dumps(
            {
                "accounts": [source_account],
                "collections": [{"owner": admin, "revision": 1}],
                "records": [
                    {
                        "id": "synthetic-source-position",
                        "owner": admin,
                        "account": account["id"],
                        "market": "HK",
                        "accountMarket": "CN",
                    }
                ],
                "recordRevisions": {admin: 1},
                "steps": steps,
            }
        ),
        text=True,
        capture_output=True,
        check=True,
    )
    expected = json.loads(run.stdout)
    for step, old in zip(steps, expected, strict=True):
        path = (
            f"/api/v{step['version']}/broker-accounts"
            + (
                "/presets"
                if step["action"] == "presets"
                else "/" + step["id"]
                if step["action"] == "account"
                else ""
            )
            + step.get("query", "")
        )
        response = await client.get(path, headers=bearer(pair))
        assert response.status_code == old["status"], response.text
        current = response.json()
        if response.status_code == 200 and step["action"] != "presets":
            entries = current["data"]["items"] if step["action"] == "list" else [current["data"]]
            original = old["body"]["data"]["items"] if step["action"] == "list" else [old["body"]["data"]]
            for entry, legacy in zip(entries, original, strict=True):
                assert entry.pop("accountKind") == "real"
                usage = entry["currencyUsage"]
                assert usage.pop("platformComplete") is True
                assert usage.pop("historicalCoverageKnown") is False
                assert usage.pop("coverageScope") == "platform_registered_dependencies"
                # Deliberate authority hardening: the old full-source boolean cannot
                # describe a platform whose legacy historical source is not imported.
                assert usage.pop("complete") is False
                assert legacy["currencyUsage"].pop("complete") is True
        assert current == old["body"]
        assert "no-store" in response.headers["cache-control"]
        assert response.headers["x-alcor-source-coverage"] == "platform-only"
    # Cookie and old login sessions are not App financial grants.
    assert (await client.get("/api/v2/broker-accounts")).status_code == 401
    assert (
        await client.get("/api/v2/broker-accounts", headers={"authorization": pair["access_token"]})
    ).status_code == 401
    assert (
        await client.get(
            "/api/v2/broker-accounts", headers={"authorization": "bearer " + pair["access_token"]}
        )
    ).status_code == 401
    denied = await grant(db, admin, "portfolio.read security.read")
    async with db.connection() as conn:
        # Exercise a persisted grant whose portfolio consent has been withdrawn.
        await conn.execute(
            "UPDATE identity_app_grants SET scope='security.read' WHERE id=%s", (denied["grant_id"],)
        )
    assert (await client.get("/api/v1/broker-accounts", headers=bearer(denied))).status_code == 403
    simulated = await create(client, name="Synthetic simulator", account_kind="simulated")
    scoped = (await client.get("/api/v2/broker-accounts", headers=bearer(pair))).json()["data"]["items"]
    assert {(item["id"], item["accountKind"]) for item in scoped} == {
        (account["id"], "real"),
        (simulated["id"], "simulated"),
    }
    assert all(
        item["currencyUsage"]["complete"] is False
        and item["currencyUsage"]["historicalCoverageKnown"] is False
        for item in scoped
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'statement','unknown-currency',NULL)",
            (admin, account["id"]),
        )
    result = await client.get("/api/v2/broker-accounts/" + account["id"], headers=bearer(pair))
    assert result.json()["data"]["currencyUsage"] == {
        "complete": False,
        "platformComplete": False,
        "historicalCoverageKnown": False,
        "coverageScope": "platform_registered_dependencies",
        "usedCurrencies": ["CNY", "HKD"],
        "recordCollectionRevision": 1,
        "issues": ["unknown_currency"],
    }
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s", (admin,))
        ).fetchone()
        assert (
            await (
                await conn.execute(
                    "SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["revision"] == 1


async def test_broker_native_owner_grant_revocation_and_tombstone(client, db, admin, settings, app):
    from uuid import uuid4

    import httpx
    from alcor_api.cli import create_user

    account = await create(client)
    pair = await grant(db, admin, "portfolio.read")
    await create_user(settings, "SyntheticBrokerReadPeer", "Synthetic9Pass")
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT id FROM users WHERE username='SyntheticBrokerReadPeer'")
        ).fetchone()
    peer = await grant(db, row["id"], "portfolio.read")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        assert (await anonymous.get("/api/v2/broker-accounts")).status_code == 401
    assert (await client.get("/api/v2/broker-accounts", headers=bearer(peer))).json()["data"]["items"] == []
    assert (
        await client.get("/api/v2/broker-accounts/" + account["id"], headers=bearer(peer))
    ).status_code == 404
    removed = await client.request(
        "DELETE", "/api/broker-accounts/" + account["id"], json={"request_id": str(uuid4()), "revision": 1}
    )
    assert removed.status_code == 200, removed.text
    assert (await client.get("/api/v2/broker-accounts", headers=bearer(pair))).json()["data"]["items"] == []
    assert (
        await client.get("/api/v2/broker-accounts/" + account["id"], headers=bearer(pair))
    ).status_code == 404
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s", (admin,)
        )
    assert (await client.get("/api/v2/broker-accounts", headers=bearer(pair))).status_code == 401
