import asyncio
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from psycopg.errors import CheckViolation


async def account(client, name="Cash Broker", account_kind="real"):
    result = await client.post(
        "/api/broker-accounts",
        json={
            "request_id": str(uuid4()),
            "name": name,
            "provider_id": None,
            "account_kind": account_kind,
            "currency": "USD",
            "currencies": ["USD", "HKD"],
        },
    )
    assert result.status_code == 201, result.text
    return result.json()["data"]["id"]


def command(account_id, action="opening", amount="100", **kwargs):
    return {
        "requestId": str(uuid4()),
        "accountId": account_id,
        "accountKind": "real",
        "currency": "USD",
        "action": action,
        "amount": amount,
        "occurredAt": "2026-01-01T00:00:00Z",
        **({"openingBasis": "new_external_opening"} if action == "opening" else {}),
        **kwargs,
    }


async def submit(client, data):
    preview = await client.post("/api/cash/preview", json=data)
    assert preview.status_code == 200, preview.text
    response = await client.post(
        "/api/cash/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert response.status_code == 200, response.text
    return response.json(), preview.json()["preview"]


@pytest.mark.asyncio
async def test_unknown_zero_currencies_and_external_opening(client, admin):
    identifier = await account(client)
    before = (await client.get("/api/cash/accounts/" + identifier)).json()
    assert all(row["balance"] is None and not row["complete"] for row in before["currencies"])
    result, _ = await submit(client, command(identifier, amount="0"))
    assert result["ownerCashAfter"] == "0"
    after = (await client.get("/api/cash/accounts/" + identifier)).json()
    assert after["currencies"][0]["balance"] == "0"
    assert after["currencies"][1]["balance"] is None
    assert (await client.post("/api/cash/preview", json=command(identifier))).status_code == 409


@pytest.mark.asyncio
async def test_allocation_moves_attribution_without_minting_cash(client, admin, db):
    await submit(client, command(None, amount="1000"))
    identifier = await account(client)
    result, _ = await submit(
        client, command(identifier, amount="600", openingBasis="allocate_verified_unallocated_checkpoint")
    )
    assert result["ownerCashAfter"] == "1000" and result["balanceAfter"] == "600"
    assert not result["affectsOwnerCash"]
    other = await account(client, "Second")
    assert (
        await client.post(
            "/api/cash/preview",
            json=command(other, amount="401", openingBasis="allocate_verified_unallocated_checkpoint"),
        )
    ).status_code == 409
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT affects_owner,sum(amount) AS amount FROM cash_ledger_entries WHERE owner_id=%s GROUP BY affects_owner",
                (admin,),
            )
        ).fetchall()
        assert {r["affects_owner"]: r["amount"] for r in rows} == {True: 1000, False: 600}


@pytest.mark.asyncio
async def test_reconcile_appends_delta_and_idempotent_receipt(client, admin, db):
    identifier = await account(client)
    await submit(client, command(identifier))
    data = command(identifier, "reconcile_balance", "91.12")
    result, proof = await submit(client, data)
    assert result["delta"] == "-8.88" and result["balanceAfter"] == "91.12"
    replay = await client.post("/api/cash/operations", json={"data": data, "preview": proof})
    assert replay.json() == result
    assert (await client.get("/api/cash/operations/" + data["requestId"])).json() == result
    assert (
        await client.post("/api/cash/operations", json={"data": {**data, "amount": "90"}, "preview": proof})
    ).status_code == 409
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 2
        with pytest.raises(CheckViolation):
            await conn.execute("UPDATE cash_ledger_entries SET amount=0 WHERE owner_id=%s", (admin,))


@pytest.mark.asyncio
async def test_two_previews_only_one_cash_effect(client, admin):
    identifier = await account(client)
    await submit(client, command(identifier))
    a = command(identifier, "external_withdrawal", "70")
    b = command(identifier, "external_withdrawal", "70")
    pa = (await client.post("/api/cash/preview", json=a)).json()["preview"]
    pb = (await client.post("/api/cash/preview", json=b)).json()["preview"]
    results = await asyncio.gather(
        client.post("/api/cash/operations", json={"data": a, "preview": pa}),
        client.post("/api/cash/operations", json={"data": b, "preview": pb}),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    current = (await client.get("/api/cash/accounts/" + identifier)).json()
    assert current["currencies"][0]["balance"] == "30"
    assert (
        await client.post("/api/cash/preview", json=command(identifier, "external_withdrawal", "30.00000001"))
    ).status_code == 409


@pytest.mark.asyncio
async def test_receipt_failure_rolls_back_every_effect_and_same_uuid_can_retry(client, admin, db):
    identifier = await account(client)
    data = command(identifier)
    proof = (await client.post("/api/cash/preview", json=data)).json()["preview"]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_cash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt fault'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_cash_receipt BEFORE INSERT ON cash_ledger_operations FOR EACH ROW EXECUTE FUNCTION reject_cash_receipt()"
        )
    failed = await client.post("/api/cash/operations", json={"data": data, "preview": proof})
    assert failed.status_code == 503
    async with db.connection() as conn:
        for table in ("cash_ledger_entries", "cash_ledger_accounts", "cash_ledger_operations"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT consumed_at FROM cash_ledger_previews")).fetchone())[
            "consumed_at"
        ] is None
        await conn.execute("DROP TRIGGER reject_cash_receipt ON cash_ledger_operations")
    retry = await client.post("/api/cash/operations", json={"data": data, "preview": proof})
    assert retry.status_code == 200


@pytest.mark.asyncio
async def test_expired_tampered_cross_session_and_official_refuse(client, admin, db):
    identifier = await account(client)
    data = command(identifier)
    proof = (await client.post("/api/cash/preview", json=data)).json()["preview"]
    assert (
        await client.post("/api/cash/operations", json={"data": {**data, "amount": "101"}, "preview": proof})
    ).status_code == 409
    async with db.connection() as conn:
        await conn.execute("UPDATE cash_ledger_previews SET expires_at=clock_timestamp()-interval '1 second'")
    assert (
        await client.post("/api/cash/operations", json={"data": data, "preview": proof})
    ).status_code == 409
    async with db.connection() as conn:
        await conn.execute("UPDATE broker_accounts SET holding_source='official' WHERE id=%s", (identifier,))
    assert (await client.post("/api/cash/preview", json=data)).status_code == 409
    assert (
        await client.post("/api/cash/preview", json=data, headers={"x-csrf-token": "bad"})
    ).status_code == 403


@pytest.mark.asyncio
async def test_real_simulated_and_currency_pools_are_independent(client, admin):
    real = await account(client, "Real")
    simulated = await account(client, "Simulated", account_kind="simulated")
    await submit(client, command(None, amount="1000", accountKind="simulated"))
    # A simulated source never funds a real account, even when both belong to the same user.
    attempt = command(real, amount="1", openingBasis="allocate_verified_unallocated_checkpoint")
    assert (await client.post("/api/cash/preview", json=attempt)).status_code == 409
    assert (
        await client.post("/api/cash/preview", json={**attempt, "accountKind": "simulated"})
    ).status_code == 409
    result, _ = await submit(
        client,
        command(
            simulated,
            amount="900",
            accountKind="simulated",
            openingBasis="allocate_verified_unallocated_checkpoint",
        ),
    )
    assert result["ownerCashAfter"] == "1000"
    await submit(client, command(None, amount="100"))
    result, _ = await submit(
        client, command(real, amount="100", openingBasis="allocate_verified_unallocated_checkpoint")
    )
    assert result["ownerCashAfter"] == "100"
    assert (
        await client.post("/api/cash/preview", json=command(real, "external_withdrawal", "101"))
    ).status_code == 409
    # USD never funds HKD without an explicit actual currency conversion event.
    assert (
        await client.post(
            "/api/cash/preview",
            json=command(
                real, amount="1", currency="HKD", openingBasis="allocate_verified_unallocated_checkpoint"
            ),
        )
    ).status_code == 409
    await submit(client, command(real, amount="200", currency="HKD"))
    result, _ = await submit(client, command(real, "external_withdrawal", "100", currency="HKD"))
    assert result["ownerCashAfter"] == "100"
    values = (await client.get("/api/cash/accounts/" + real)).json()["currencies"]
    assert {x["currency"]: x["balance"] for x in values} == {"USD": "100", "HKD": "100"}


@pytest.mark.asyncio
async def test_precision_smallest_amount_and_allocation_never_rounds_or_overdraws(client, admin):
    source = "9007199254740990.000000000000000001"
    await submit(client, command(None, amount=source))
    first = await account(client, "First exact")
    second = await account(client, "Second exact")
    result, _ = await submit(
        client, command(first, amount=source, openingBasis="allocate_verified_unallocated_checkpoint")
    )
    assert result["ownerCashAfter"] == source and result["balanceAfter"] == source
    # Unary Decimal negation at default precision would round attribution and invent 1e-18 here.
    assert (
        await client.post(
            "/api/cash/preview",
            json=command(
                second, amount="0.000000000000000001", openingBasis="allocate_verified_unallocated_checkpoint"
            ),
        )
    ).status_code == 409
    result, _ = await submit(client, command(first, "external_withdrawal", "0.000000000000000001"))
    assert Decimal(result["balanceAfter"]) == Decimal(9007199254740990)
    assert Decimal(result["ownerCashAfter"]) == Decimal(9007199254740990)
    result, _ = await submit(
        client, command(first, "reconcile_balance", "9007199254740989.999999999999999999")
    )
    assert Decimal(result["delta"]) == Decimal("-0.000000000000000001")
    for amount in ("1e-19", "9007199254740991.000000000000000001", True, 0.1, "NaN", "Infinity"):
        assert (
            await client.post("/api/cash/preview", json=command(second, amount=amount))
        ).status_code == 422


@pytest.mark.asyncio
async def test_unknown_checkpoint_and_backdated_reconciliation_never_fabricate_history(client, admin):
    identifier = await account(client)
    empty = command(identifier, amount="0", openingBasis="allocate_verified_unallocated_checkpoint")
    assert (await client.post("/api/cash/preview", json=empty)).status_code == 409
    await submit(client, command(None, amount="100", occurredAt="2026-01-02T00:00:00Z"))
    assert (await client.post("/api/cash/preview", json={**empty, "amount": "100"})).status_code == 409
    await submit(client, {**empty, "amount": "100", "occurredAt": "2026-01-02T00:00:00Z"})
    await submit(client, command(identifier, "external_deposit", "10", occurredAt="2026-01-03T00:00:00Z"))
    old = command(identifier, "reconcile_balance", "90", occurredAt="2026-01-02T00:00:00Z")
    assert (await client.post("/api/cash/preview", json=old)).status_code == 409
    result, _ = await submit(client, {**old, "occurredAt": "2026-01-03T00:00:00Z"})
    assert result["delta"] == "-20"
    # A later USD event cannot prevent establishing an independently evidenced HKD opening.
    await submit(client, command(identifier, amount="5", currency="HKD", occurredAt="2026-01-01T00:00:00Z"))


@pytest.mark.asyncio
async def test_cross_owner_account_and_cross_session_proof_are_rejected(client, admin, app, settings):
    identifier = await account(client)
    data = command(identifier)
    proof = (await client.post("/api/cash/preview", json=data)).json()["preview"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        await create_user(settings, "CashOtherOwner", "Synthetic9Pass")
        login = await other.post(
            "/api/session/login", json={"login": "CashOtherOwner", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get("/api/cash/accounts/" + identifier)).status_code == 404
        assert (await other.post("/api/cash/preview", json=data)).status_code == 404
        assert (
            await other.post("/api/cash/operations", json={"data": data, "preview": proof})
        ).status_code == 409
        # Even a second legitimate session for the owner cannot reuse the first session's confirmation.
        login = await other.post(
            "/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (
            await other.post("/api/cash/operations", json={"data": data, "preview": proof})
        ).status_code == 409
    result = await client.post("/api/cash/operations", json={"data": data, "preview": proof})
    assert result.status_code == 200


@pytest.mark.asyncio
async def test_revoked_identity_waiting_for_cash_lock_cannot_consume_proof(client, admin, db):
    identifier = await account(client)
    data = command(identifier)
    proof = (await client.post("/api/cash/preview", json=data)).json()["preview"]
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("broker-accounts:" + admin,)
        )
        pending = asyncio.create_task(
            client.post("/api/cash/operations", json={"data": data, "preview": proof})
        )
        async with db.connection() as observer:
            waiting = False
            for _ in range(100):
                row = await (
                    await observer.execute(
                        "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() "
                        "AND wait_event_type='Lock' AND wait_event='advisory'"
                    )
                ).fetchone()
                if row["n"]:
                    waiting = True
                    break
                await asyncio.sleep(0.01)
            assert waiting
            await observer.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    assert (await pending).status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM cash_ledger_entries")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT consumed_at FROM cash_ledger_previews")).fetchone())[
            "consumed_at"
        ] is None


@pytest.mark.asyncio
async def test_cash_database_guards_reject_false_opening_wrong_kind_and_source(client, admin, db):
    identifier = await account(client)
    await submit(client, command(identifier, amount="0"))
    async with db.connection() as conn:
        for kind, affects, amount, account_kind in [
            ("allocation", True, "1", "real"),
            ("external_withdrawal", True, "1", "real"),
            ("external_deposit", True, "1", "simulated"),
        ]:
            with pytest.raises(CheckViolation):
                async with conn.transaction():
                    await conn.execute(
                        "INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,"
                        "request_id,kind,amount,affects_owner,occurred_at,note) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (
                            uuid4(),
                            admin,
                            identifier,
                            account_kind,
                            "USD",
                            uuid4(),
                            kind,
                            Decimal(amount),
                            affects,
                            "2026-01-01T00:00:00Z",
                            "",
                        ),
                    )
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE cash_ledger_accounts SET opening_at='2025-01-01'")
        await conn.execute("UPDATE broker_accounts SET holding_source='official' WHERE id=%s", (identifier,))
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,"
                    "request_id,kind,amount,affects_owner,occurred_at,note) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        uuid4(),
                        admin,
                        identifier,
                        "real",
                        "USD",
                        uuid4(),
                        "external_deposit",
                        1,
                        True,
                        "2026-01-01T00:00:00Z",
                        "",
                    ),
                )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"requestId": 17},
        {"occurredAt": 17},
        {"occurredAt": None},
        {"accountKind": []},
        {"amount": "1e-19"},
        {"amount": "-1"},
        {"currency": "usd"},
    ],
)
async def test_malformed_cash_input_is_rejected_without_server_failure(client, admin, changes):
    assert (await client.post("/api/cash/preview", json=command(None, **changes))).status_code == 422


@pytest.mark.asyncio
async def test_other_broker_cash_does_not_hide_zero_balance(client, admin):
    first = await account(client, "Funded account")
    empty = await account(client, "Zero account")
    await submit(client, command(first, amount="1000000"))
    await submit(client, command(empty, amount="0"))
    assert (
        await client.post(
            "/api/cash/preview", json=command(empty, "external_withdrawal", "0.000000000000000001")
        )
    ).status_code == 409
    before = (await client.get("/api/cash/accounts/" + first)).json()
    assert before["currencies"][0]["balance"] == "1000000"


@pytest.mark.asyncio
async def test_opening_cannot_borrow_another_account_posting(client, admin, db):
    first = await account(client, "First opening")
    second = await account(client, "Unproven opening")
    data = command(first, amount="0")
    await submit(client, data)
    async with db.connection() as conn:
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO cash_ledger_accounts(owner_id,account_id,currency,opening_at,"
                    "opening_basis,opening_request_id) VALUES(%s,%s,%s,%s,%s,%s)",
                    (admin, second, "USD", data["occurredAt"], "new_external_opening", data["requestId"]),
                )
    snapshot = (await client.get("/api/cash/accounts/" + second)).json()
    assert snapshot["currencies"][0]["balance"] is None


# Reuse the identity-checked private backup target, rather than introducing another database harness.
import test_backups as backup_tests

backup_app = backup_tests.backup_app
bc = backup_tests.bc
configured = backup_tests.configured


@pytest.mark.asyncio
async def test_named_cash_openings_postings_and_receipts_survive_real_restore(bc, backup_app, configured):
    from uuid import UUID

    import psycopg
    from psycopg.rows import dict_row
    from test_backups import create_capsule, execute
    from test_backups import submit as submit_backup

    await submit(bc, command(None, amount="1000.000000000000000001"))
    identifier = await account(bc, "Restore cash account")
    await submit(
        bc,
        command(
            identifier,
            amount="600.000000000000000001",
            openingBasis="allocate_verified_unallocated_checkpoint",
        ),
    )
    await submit(bc, command(identifier, "reconcile_balance", "500.000000000000000001"))
    tables = (
        "broker_accounts",
        "broker_account_references",
        "cash_ledger_accounts",
        "cash_ledger_entries",
        "cash_ledger_operations",
        "cash_ledger_collections",
    )
    expected = {}
    async with backup_app.state.db.connection() as conn:
        for table in tables:
            expected[table] = await (
                await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")
            ).fetchall()
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await submit_backup(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    result = await execute(backup_app, configured, UUID(job["id"]))
    assert result["sessions_revoked"]
    target = configured.restore_targets[0]
    async with await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        for table in tables:
            restored = await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
            assert restored == expected[table], table
        # Full restore must reinstall the same authoritative immutability guards.
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE cash_ledger_entries SET amount=0")


@pytest.mark.asyncio
async def test_preview_identity_expiry_and_old_receipt_state_projection(client, admin, db):
    from alcor_api.security import digest

    identifier = await account(client)
    data = command(identifier)
    preview = await client.post("/api/cash/preview", json=data)
    assert preview.status_code == 200
    proof = preview.json()
    assert proof["accountId"] == identifier and proof["accountKind"] == "real"
    async with db.connection() as conn:
        stored = await (
            await conn.execute(
                "SELECT expires_at FROM cash_ledger_previews WHERE token_hash=%s", (digest(proof["preview"]),)
            )
        ).fetchone()
        assert proof["expiresAt"] == stored["expires_at"].isoformat()
    response = await client.post("/api/cash/operations", json={"data": data, "preview": proof["preview"]})
    assert response.status_code == 200 and response.json()["state"] == "completed"
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE cash_ledger_operations SET result=result-'state' WHERE owner_id=%s AND request_id=%s",
            (admin, data["requestId"]),
        )
        await conn.commit()
    read = await client.get("/api/cash/operations/" + data["requestId"])
    repeated = await client.post("/api/cash/operations", json={"data": data, "preview": proof["preview"]})
    assert read.json() == repeated.json() == response.json()
    async with db.connection() as conn:
        stored = await (
            await conn.execute(
                "SELECT result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s",
                (admin, data["requestId"]),
            )
        ).fetchone()
        assert "state" not in stored["result"]
