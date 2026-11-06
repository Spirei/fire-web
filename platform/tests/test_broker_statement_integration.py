"""One isolated synthetic lifecycle for official source snapshots; no provider network."""

from uuid import uuid4

import pytest
from alcor_api.broker_flex_transport import Reply, Transport
from test_cash_ledger import account

BASE = "/api/account/broker-statements"
XML = """<FlexQueryResponse><FlexStatements><FlexStatement accountId="SYNTHETIC" fromDate="20260101" toDate="20260131"><OpenPositions><OpenPosition levelOfDetail="SUMMARY" assetCategory="STK" reportDate="20260131" listingExchange="NASDAQ" currency="USD" conid="1" symbol="SYNTH" description="Synthetic Position" position="2" markPrice="12" costBasisPrice="10"/></OpenPositions><CashReportCurrency currency="USD" endingCash="0"/><CashReportCurrency currency="EUR" endingCash="25"/></FlexStatement></FlexStatements></FlexQueryResponse>"""


async def test_official_statement_full_synthetic_lifecycle(client, admin, db, settings, monkeypatch):
    identifier = await account(client)

    async def post(path, body):
        response = await client.post(BASE + path, json=body)
        assert response.status_code == 200, response.text
        return response.json()

    preview_body = {
        "requestId": str(uuid4()),
        "accountId": identifier,
        "accountKind": "real",
        "revision": 1,
        "externalAccount": "SYNTHETIC",
        "xml": XML,
    }
    preview = await post("/preview", preview_body)
    assert preview["financialEffect"] == "none"
    assert await post("/preview", preview_body) == preview
    original = await client.get(BASE + "/originals/" + preview["originalId"])
    assert original.content == XML.encode()
    confirm = {
        "requestId": str(uuid4()),
        "previewId": preview["previewId"],
        "confirmExternalAccount": "SYNTHETIC",
        "takeOverOfficial": True,
        "acknowledgeUnassigned": True,
    }
    imported = await post("/imports", confirm)
    assert imported["state"] == "completed"
    assert await post("/imports", confirm) == imported
    closed_id = str(uuid4())
    closed = await post("/imports/" + closed_id + "/close", {})
    assert closed["state"] == "closed"
    assert await post("/imports", dict(confirm, requestId=closed_id)) == closed
    records = await client.get("/api/portfolio/records")
    assert records.status_code == 200, records.text
    row = next(r for r in records.json()["records"] if r["brokerAccountId"] == identifier)
    assert row["qty"] == "2" and row["cost"] == "10" and row["price"] == "12"
    assert row["registeredQty"] is None and row["costAuthority"] == "official_reported_cost_basis"
    assert row["officialObservation"]["reportDate"] == "2026-01-31"
    cash_response = await client.get("/api/cash/accounts/" + identifier)
    assert cash_response.status_code == 200, cash_response.text
    cash = {r["currency"]: r for r in cash_response.json()["currencies"]}
    assert cash["USD"]["balance"] == "0" and cash["HKD"]["balance"] is None
    assert cash["EUR"]["sourceOnly"] and not cash["EUR"]["configured"] and cash["EUR"]["balance"] == "25"
    assert all(not r["ownerCashComplete"] and r["opening"] is None for r in cash.values())
    settings.broker_statement_targets = [
        {
            "owner_id": admin,
            "purposes": ["statement.fetch"],
            "license_revision": "synthetic-v1",
            "valid_until": "2099-01-01T00:00:00+00:00",
            "addresses": ["8.8.8.8"],
            "id": "synthetic",
        }
    ]
    source = await post(
        "/accounts/" + identifier + "/source",
        {
            "requestId": str(uuid4()),
            "accountKind": "real",
            "accountRevision": 2,
            "connectionRevision": 0,
            "targetId": "synthetic",
            "externalAccount": "SYNTHETIC",
            "queryId": "123",
            "token": "SYNTHETICTOKEN12345",
        },
    )
    calls = []

    async def controlled(self, token, query, **kwargs):
        calls.append(kwargs.get("reference"))
        return (
            Reply("pending", reference="123", raw=b"<synthetic-pending/>", http_status=200, complete=True)
            if len(calls) == 1
            else Reply("statement", reference="123", raw=XML.encode(), http_status=200, complete=True)
        )

    monkeypatch.setattr(Transport, "request", controlled)
    pending_body = {"requestId": str(uuid4()), "connectionRevision": 1}
    pending = await post("/accounts/" + identifier + "/fetch", pending_body)
    assert pending["state"] == "pending"
    assert await post("/accounts/" + identifier + "/fetch", pending_body) == pending and calls == [None]
    fetched = await post(
        "/accounts/" + identifier + "/fetch",
        {"requestId": str(uuid4()), "connectionRevision": 1, "previousRequestId": pending_body["requestId"]},
    )
    assert fetched["state"] == "previewed" and calls == [None, "123"]
    # Explicitly advance this synthetic user's rate window, rather than weaken transport limits.
    from alcor_api.security import digest

    async with db.connection() as conn:
        await conn.execute(
            "UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=%s",
            (digest("statement-preview:" + admin),),
        )
    disabled_response = await client.request(
        "DELETE",
        BASE + "/accounts/" + identifier + "/source",
        json={
            "requestId": str(uuid4()),
            "connectionRevision": 1,
            "accountRevision": source["accountRevision"],
        },
    )
    assert disabled_response.status_code == 200, disabled_response.text
    assert disabled_response.json()["state"] == "disabled"
    rejected = await client.post(
        BASE + "/accounts/" + identifier + "/fetch", json={"requestId": str(uuid4()), "connectionRevision": 1}
    )
    assert rejected.status_code == 409 and len(calls) == 2
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM trade_ledger WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == 0
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM cash_ledger_entries WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == 0


async def test_native_empty_fetch_concurrency_binding_pending_and_original_apply(
    client, admin, db, settings, monkeypatch
):
    import asyncio

    from test_legacy_devices import bearer, grant

    identifier = await account(client, name="Native Synthetic")
    pair = await grant(db, admin, "portfolio.read portfolio.write")
    other = await grant(db, admin, "portfolio.read portfolio.write")
    settings.broker_statement_targets = [
        {
            "owner_id": admin,
            "purposes": ["statement.fetch"],
            "license_revision": "synthetic-v1",
            "valid_until": "2099-01-01T00:00:00+00:00",
            "addresses": ["8.8.8.8"],
            "id": "synthetic",
        }
    ]
    configured = await client.post(
        BASE + "/accounts/" + identifier + "/source",
        json={
            "requestId": str(uuid4()),
            "accountKind": "real",
            "accountRevision": 1,
            "connectionRevision": 0,
            "targetId": "synthetic",
            "externalAccount": "SYNTHETIC",
            "queryId": "123",
            "token": "SYNTHETICTOKEN12345",
        },
    )
    assert configured.status_code == 200, configured.text
    admitted, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def controlled(self, token, query, **kwargs):
        calls.append(kwargs.get("reference"))
        if len(calls) == 1:
            admitted.set()
            await release.wait()
            return Reply(
                "pending", reference="321", raw=b"<synthetic-pending/>", http_status=200, complete=True
            )
        return Reply("statement", reference="321", raw=XML.encode(), http_status=200, complete=True)

    monkeypatch.setattr(Transport, "request", controlled)
    path = "/api/v1/broker-accounts/" + identifier + "/statements/fetch"
    task = asyncio.create_task(client.post(path, headers=bearer(pair)))
    try:
        await asyncio.wait_for(admitted.wait(), 5)
        unknown = await client.post(path.replace("/v1/", "/v2/"), headers=bearer(pair))
        assert unknown.status_code == 503, unknown.text
        cross_binding = await client.post(path, headers=bearer(other))
        assert cross_binding.status_code == 409, cross_binding.text
        async with db.connection() as conn:
            pending_id = str(
                (
                    await (
                        await conn.execute(
                            "SELECT request_id FROM broker_statement_source_attempts WHERE owner_id=%s AND account_id=%s AND kind='fetch'",
                            (admin, identifier),
                        )
                    ).fetchone()
                )["request_id"]
            )
        assert pending_id not in cross_binding.text
        assert calls == [None]
    finally:
        release.set()
        pending = await task
    assert pending.status_code == 202, pending.text
    assert pending.json()["data"]["pending"] is True
    fetched = await client.post(path.replace("/v1/", "/v2/"), headers=bearer(pair))
    assert fetched.status_code == 200, fetched.text
    preview = fetched.json()["data"]
    assert calls == [None, "321"] and preview["requiresOfficialTakeover"] is True
    # Original App fields suffice: no newly invented external-account confirmation.
    apply = await client.post(
        path.replace("/fetch", "/apply"),
        headers=bearer(pair),
        json={
            "requestId": str(uuid4()),
            "revision": preview["accountRevision"],
            "previewId": preview["previewId"],
            "takeOverOfficial": True,
        },
    )
    assert apply.status_code == 200, apply.text
    assert apply.json()["data"]["state"] == "completed"
    async with db.connection() as conn:
        account_row = await (
            await conn.execute(
                "SELECT holding_source FROM broker_accounts WHERE owner_id=%s AND id=%s", (admin, identifier)
            )
        ).fetchone()
        assert account_row["holding_source"] == "official"
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s",
                    (admin, identifier),
                )
            ).fetchone()
        )["n"] == 1


async def test_import_uuid_cannot_cross_real_simulated_or_owner_and_original_stays_exact(
    client, admin, db, settings, app
):
    import hashlib

    import httpx
    from alcor_api.cli import create_user

    real = await account(client, name="Synthetic isolated real", account_kind="real")
    simulated = await account(client, name="Synthetic isolated simulated", account_kind="simulated")
    previews = []
    for account_id, kind, external in (
        (real, "real", "SYNTHETIC-REAL"),
        (simulated, "simulated", "SYNTHETIC-SIM"),
    ):
        xml = XML.replace('accountId="SYNTHETIC"', 'accountId="' + external + '"')
        response = await client.post(BASE + "/preview", json={
            "requestId": str(uuid4()), "accountId": account_id, "accountKind": kind,
            "revision": 1, "externalAccount": external, "xml": xml,
        })
        assert response.status_code == 200, response.text
        previews.append((response.json(), xml, external))
    original, xml, external = previews[0]
    request_id = str(uuid4())
    command = {
        "requestId": request_id, "previewId": original["previewId"],
        "confirmExternalAccount": external, "takeOverOfficial": True, "acknowledgeUnassigned": True,
    }
    imported = await client.post(BASE + "/imports", json=command)
    assert imported.status_code == 200, imported.text
    receipt = imported.json()
    assert receipt["accountId"] == real and receipt["accountKind"] == "real"
    replacement = await client.post(BASE + "/imports", json={
        **command, "previewId": previews[1][0]["previewId"],
        "confirmExternalAccount": previews[1][2],
    })
    assert replacement.status_code == 409, replacement.text
    assert (await client.get(BASE + "/imports/" + request_id)).json() == receipt
    assert (await client.post(BASE + "/imports", json=command)).json() == receipt
    assert (await client.post(BASE + "/imports/" + request_id + "/close", json={})).json() == receipt

    await create_user(settings, "SyntheticStatementOther", "SyntheticStatementOther9", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver", headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post("/api/session/login", json={
            "login": "SyntheticStatementOther", "password": "SyntheticStatementOther9",
        })
        assert login.status_code == 200, login.text
        other.headers["x-csrf-token"] = login.json()["csrf"]
        source = await other.get(BASE + "/originals/" + original["originalId"])
        assert source.status_code == 404 and XML not in source.text
        foreign_receipt = await other.get(BASE + "/imports/" + request_id)
        assert foreign_receipt.status_code == 404, foreign_receipt.text
        attempted = await other.post(BASE + "/imports", json={**command, "requestId": str(uuid4())})
        assert attempted.status_code == 409, attempted.text

    preserved = await client.get(BASE + "/originals/" + original["originalId"])
    assert preserved.status_code == 200 and preserved.content == xml.encode()
    assert hashlib.sha256(preserved.content).hexdigest() == receipt["sourceSha256"]
    async with db.connection() as conn:
        untouched = await (await conn.execute(
            "SELECT account_kind,holding_source,revision FROM broker_accounts WHERE owner_id=%s AND id=%s",
            (admin, simulated),
        )).fetchone()
        assert untouched == {"account_kind": "simulated", "holding_source": "manual", "revision": 1}
        assert not await (await conn.execute(
            "SELECT 1 FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s", (admin, simulated)
        )).fetchone()
        for table in ("trade_ledger", "cash_ledger_entries"):
            assert not await (await conn.execute(f"SELECT 1 FROM {table} WHERE owner_id=%s", (admin,))).fetchone()


@pytest.mark.parametrize("failure", ["grant_revoked", "license_revoked", "parse_failed", "instance_replaced", "http_error"])
async def test_received_flex_response_survives_late_rejection_and_uuid_never_refetches(
    client, admin, db, settings, monkeypatch, failure
):
    import hashlib

    from test_legacy_devices import bearer, grant

    identifier = await account(client, name="Synthetic retained Flex response")
    pair = await grant(db, admin, "portfolio.read portfolio.write")
    settings.broker_statement_targets = [{
        "owner_id": admin, "purposes": ["statement.fetch"], "license_revision": "synthetic-retain-v1",
        "valid_until": "2099-01-01T00:00:00+00:00", "addresses": ["8.8.8.8"], "id": "synthetic-retain",
    }]
    configured = await client.post(BASE + "/accounts/" + identifier + "/source", json={
        "requestId": str(uuid4()), "accountKind": "real", "accountRevision": 1, "connectionRevision": 0,
        "targetId": "synthetic-retain", "externalAccount": "SYNTHETIC", "queryId": "123",
        "token": "SYNTHETICRETAIN12345",
    })
    assert configured.status_code == 200, configured.text
    raw = b"<invalid-flex-source>SYNTHETICRETAIN12345 unclosed" if failure == "parse_failed" else XML.encode()
    if failure == "http_error":
        raw = b"<Error>SYNTHETICRETAIN12345 truncated-provider-response"
    calls = []
    original_instance = settings.instance_id

    async def controlled(self, token, query, **kwargs):
        calls.append(kwargs.get("reference"))
        if failure == "grant_revoked":
            async with db.connection() as conn:
                await conn.execute("UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],))
        elif failure == "license_revoked":
            settings.broker_statement_targets = []
        elif failure == "instance_replaced":
            settings.instance_id = uuid4()
        return Reply("unknown" if failure == "http_error" else "statement", raw=raw, http_status=503 if failure == "http_error" else 200, complete=failure != "http_error")

    monkeypatch.setattr(Transport, "request", controlled)
    rid = str(uuid4())
    body = {"requestId": rid, "connectionRevision": 1}
    native_path = "/api/client/broker-statements/accounts/" + identifier + "/fetch"
    try:
        fetched = await client.post(native_path, headers=bearer(pair), json=body)
    finally:
        settings.instance_id = original_instance
    if failure == "instance_replaced":
        assert fetched.status_code >= 400 and calls == [None]
        repeated = await client.post(BASE + "/accounts/" + identifier + "/fetch", json=body)
        assert repeated.status_code == 200 and repeated.json()["state"] == "unknown" and calls == [None]
        async with db.connection() as conn:
            assert not await (await conn.execute("SELECT 1 FROM broker_statement_originals WHERE owner_id=%s", (admin,))).fetchone()
            assert not await (await conn.execute("SELECT 1 FROM broker_statement_source_results WHERE owner_id=%s AND request_id=%s", (admin, rid))).fetchone()
            assert not await (await conn.execute("SELECT 1 FROM broker_statement_imports WHERE owner_id=%s", (admin,))).fetchone()
        return
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["state"] == "unknown" and calls == [None]
    original_id = fetched.json()["responseOriginalId"]
    # A current owner session can inspect retained history; the revoked grant cannot.
    receipt = await client.get(BASE + "/source-operations/" + rid)
    assert receipt.status_code == 200 and receipt.json() == fetched.json()
    repeated = await client.post(BASE + "/accounts/" + identifier + "/fetch", json=body)
    assert repeated.status_code == 200 and repeated.json() == fetched.json() and calls == [None]
    closed = await client.post(BASE + "/source-operations/" + rid + "/close", json={})
    assert closed.status_code == 200 and closed.json() == fetched.json()
    original = await client.get(BASE + "/originals/" + original_id)
    assert original.status_code == 428 and "SYNTHETICRETAIN12345" not in original.text
    protected = BASE + "/responses/" + original_id + "/download"
    wrong_proof = await client.post(protected, json={"password": "SyntheticWrongPassword9"})
    assert wrong_proof.status_code == 403 and "SYNTHETICRETAIN12345" not in wrong_proof.text
    original = await client.post(protected, json={"password": "Synthetic9Pass"})
    assert original.status_code == 200 and original.content == raw
    assert "attachment" in original.headers["content-disposition"]
    assert "no-store" in original.headers["cache-control"]
    if failure == "grant_revoked":
        denied = await client.get("/api/client/broker-statements/originals/" + original_id, headers=bearer(pair))
        assert denied.status_code == 401, denied.text
    async with db.connection() as conn:
        stored = await (await conn.execute(
            "SELECT raw_response,http_status,response_complete FROM broker_statement_source_results WHERE owner_id=%s AND request_id=%s",
            (admin, rid),
        )).fetchone()
        assert bytes(stored["raw_response"]) == raw
        assert stored["http_status"] == (503 if failure == "http_error" else 200)
        assert stored["response_complete"] is (failure != "http_error")
        source = await (await conn.execute(
            "SELECT account_id,account_kind,external_account,source_sha256 FROM broker_statement_originals WHERE owner_id=%s AND id=%s",
            (admin, original_id),
        )).fetchone()
        assert source == {"account_id": identifier, "account_kind": "real", "external_account": "SYNTHETIC", "source_sha256": hashlib.sha256(raw).hexdigest()}
        assert not await (await conn.execute("SELECT 1 FROM broker_statement_previews WHERE owner_id=%s", (admin,))).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM broker_statement_imports WHERE owner_id=%s", (admin,))).fetchone()
        for table in ("trade_ledger", "cash_ledger_entries"):
            assert not await (await conn.execute(f"SELECT 1 FROM {table} WHERE owner_id=%s", (admin,))).fetchone()
