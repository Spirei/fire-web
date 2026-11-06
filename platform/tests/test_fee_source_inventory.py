from legacy_fee_source_fixture import old_pg
import asyncio
import copy
from uuid import uuid4

import pytest
from alcor_api.fee_source_inventory import FeeSourceInventory, fingerprint
from fastapi import HTTPException
from fee_source_test_helpers import identity, import_synthetic, synthetic_snapshot
from test_fee_repairs import request as repair_request
from test_fee_repairs import seed

P = "/api/fees/source-attributions"


async def financial_rows(db):
    async with db.connection() as conn:
        return {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1")).fetchall()
            for table in (
                "trade_ledger",
                "cash_ledger_entries",
                "portfolio_records",
                "cash_ledger_collections",
            )
        }


async def unassigned_fixture(client, db):
    aid, fill = await seed(client, db)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    extra = copy.deepcopy(source["orders"][0])
    extra.update(
        id="original-unassigned-order", originalBrokerAccountId=None, brokerAccountId=None, tradeId=None
    )
    source["orders"].append(extra)
    receipt = await import_synthetic(client, db, source, revision=1)
    return aid, fill, source, receipt


async def attribution_body(client, aid, fill):
    state = (await client.get("/api/fees/repairs", params={"brokerAccountId": aid})).json()
    return {
        "requestId": str(uuid4()),
        "sourceRevision": state["legacyCoverage"]["revision"],
        "sourceDigest": state["legacyCoverage"]["sourceDigest"],
        "orderId": "original-unassigned-order",
        "recordId": fill["record"]["id"],
        "recordRevision": fill["record"]["revision"],
        "brokerAccountId": aid,
        "brokerRevision": state["brokerRevision"],
        "basis": {
            "documentDigest": "a" * 64,
            "historicalAccountConfirmed": True,
            "completeOrderHistoryConfirmed": True,
        },
    }


@pytest.mark.asyncio
async def test_absent_original_inventory_is_unknown_not_empty_or_complete(client, admin, db):
    aid, _ = await seed(client, db, legacy=False)
    state = (await client.get("/api/fees/repairs", params={"brokerAccountId": aid})).json()
    assert state["ordersComplete"] is False
    assert state["legacyCoverage"]["status"] == "unavailable"
    assert state["unassignedOrderIds"] is None and state["unassignedOrders"] is None
    from alcor_api.native_app_auth import issue_grant

    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read orders.read", "Synthetic fee reader")
    legacy = await client.get(
        "/api/v2/account-assets/fee-repairs",
        params={"brokerAccountId": aid},
        headers={"authorization": "Bearer " + grant["access_token"]},
    )
    assert legacy.status_code == 409 and "原账" in legacy.json()["message"]


@pytest.mark.asyncio
async def test_inventory_preserves_real_unassigned_ids_unknown_fields_and_never_posts_again(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_inventory_preserves_real_unassigned_ids_unknown_fields_and_original_export_uuid as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)


@pytest.mark.asyncio
async def test_partial_known_source_does_not_claim_completeness_or_allow_financial_repair(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_partial_known_source_does_not_claim_completeness_or_allow_financial_repair as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)


@pytest.mark.asyncio
async def test_owner_recorded_zero_cannot_be_relabeled_by_a_legacy_manifest(client, admin, db):
    aid, fill = await seed(client, db, legacy=False)
    before = await financial_rows(db)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    source["orders"][0]["feeAuthority"] = "unverified_legacy"
    with pytest.raises(HTTPException, match="权威"):
        await import_synthetic(client, db, source)
    assert await financial_rows(db) == before
    state = (await client.get("/api/fees/repairs", params={"brokerAccountId": aid})).json()
    assert state["items"][0]["exclusion"] == "explicit_fee_preserved"
    assert state["legacyCoverage"]["status"] == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["source_owner", "source_hash", "target", "unassigned_mapping", "amount", "market"]
)
async def test_trial_rejects_wrong_authority_target_or_original_inputs_atomically(client, admin, db, change):
    _aid, fill = await seed(client, db, legacy=False)
    before = await financial_rows(db)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    who = await identity(client, db)
    if change == "unassigned_mapping":
        source["orders"][0]["originalBrokerAccountId"] = None
    if change == "amount":
        source["orders"][0]["input"]["amount"] = "999"
    if change == "market":
        source["orders"][0]["input"]["market"] = "HK"
    async with db.connection() as conn:
        name = (await (await conn.execute("SELECT current_database() AS name")).fetchone())["name"]
    with pytest.raises(HTTPException):
        await FeeSourceInventory(db).import_trial(
            who,
            source,
            request_id=str(uuid4()),
            expected_database="wrong" if change == "target" else name,
            expected_source_owner="other-source" if change == "source_owner" else source["sourceOwner"],
            expected_source_digest="0" * 64 if change == "source_hash" else fingerprint(source),
        )
    assert await financial_rows(db) == before
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM fee_legacy_inventory_heads")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM trade_fee_import_evidence")).fetchone()


@pytest.mark.asyncio
async def test_unassigned_owner_attribution_has_preview_cas_receipt_and_no_financial_write(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_unassigned_owner_attribution_is_only_a_choice_and_never_changes_original_unknown_kind_or_cash as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)


@pytest.mark.asyncio
async def test_changed_record_or_expired_proof_produces_durable_failure_and_never_posts(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_changed_record_or_expired_attribution_proof_has_durable_failure_and_no_posting as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path,False)


@pytest.mark.asyncio
async def test_trial_import_is_not_production_import_permission(client, admin, db, monkeypatch):
    _, fill = await seed(client, db, legacy=False)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    who = await identity(client, db)
    with monkeypatch.context() as patch:
        patch.setattr(db.settings, "environment", "production")
        with pytest.raises(HTTPException) as denied:
            await FeeSourceInventory(db).import_trial(
                who,
                source,
                request_id=str(uuid4()),
                expected_database="alcor_test_any",
                expected_source_owner=source["sourceOwner"],
                expected_source_digest=fingerprint(source),
            )
        assert denied.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["unallocated", "unknown", "not_reflected"])
async def test_original_cash_attribution_cannot_be_inferred_from_current_record_account(
    client, admin, db, scope
):
    _aid, fill = await seed(client, db, legacy=False)
    before = await financial_rows(db)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    if scope == "not_reflected":
        source["orders"][0]["cashAttribution"]["alreadyReflected"] = False
    else:
        source["orders"][0]["cashAttribution"].update(scope=scope, brokerAccountId=None)
    with pytest.raises(HTTPException, match="原现金"):
        await import_synthetic(client, db, source)
    assert await financial_rows(db) == before
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM trade_fee_import_evidence")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM fee_legacy_inventory_heads")).fetchone()


@pytest.mark.asyncio
async def test_attribution_preview_cannot_cross_session_or_turn_unknown_cash_into_a_posting(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_attribution_proof_cannot_cross_session_or_turn_unknown_cash_into_a_posting as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)


@pytest.mark.asyncio
async def test_original_cancelled_order_is_retained_but_never_imported_as_a_filled_trade(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_original_cancelled_and_all_other_nonfilled_orders_keep_versions_and_never_become_fills as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path,'cancelled')


@pytest.mark.asyncio
async def test_nonfilled_original_cannot_be_relabelled_as_a_canonical_fill(client, admin, db):
    _, fill = await seed(client, db, legacy=False)
    before = await financial_rows(db)
    source = await synthetic_snapshot(client, db, fill["tradeId"])
    source["orders"][0]["status"] = "pending"
    with pytest.raises(HTTPException):
        await import_synthetic(client, db, source)
    assert await financial_rows(db) == before


@pytest.mark.asyncio
async def test_nonfilled_original_selection_is_explicitly_excluded_not_dropped_or_rewritten(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_nonfilled_original_selection_is_explicitly_excluded_not_dropped_or_rewritten as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)
