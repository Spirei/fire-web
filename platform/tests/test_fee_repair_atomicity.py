from legacy_fee_source_fixture import old_pg
from actual_fee_test_support import actual_case
import asyncio
from decimal import Decimal
from uuid import uuid4

import pytest
from test_fee_repairs import request as repair_request
from test_fee_repairs import seed
from test_fee_source_inventory import financial_rows

P = "/api/fees/confirmations"


@pytest.mark.asyncio
async def test_concurrent_distinct_fee_requests_cannot_post_the_same_original_fee_twice(client, admin, db, app, old_pg, pg, tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee="1.03") as (client,source_app,grant,exported,aid,fill,data):
        one = data
        two = {**one, "requestId": str(uuid4())}
        p1 = (await client.post(P + "/preview", json=one)).json()
        p2 = (await client.post(P + "/preview", json=two)).json()
        results = await asyncio.gather(
            client.post(P + "/operations", json={"data": one, "preview": p1["previewRevision"]}),
            client.post(P + "/operations", json={"data": two, "preview": p2["previewRevision"]}),
        )
        assert all(r.status_code == 200 for r in results)
        assert sorted(r.json()["state"] for r in results) == ["completed", "failed"]
        async with db.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT fees,cash_delta FROM trade_ledger WHERE id=%s", (fill["tradeId"],))
                ).fetchone()
            ) == {"fees": Decimal(0), "cash_delta": Decimal(-100)}
            assert (await (await conn.execute("SELECT count(*) AS n FROM trade_fee_corrections")).fetchone())[
                "n"
            ] == 1
            assert (await (await conn.execute("SELECT count(*) AS n FROM trade_fee_projections")).fetchone())[
                "n"
            ] == 1
            assert (
                await (
                    await conn.execute(
                        "SELECT sum(amount) AS amount FROM cash_ledger_entries WHERE kind='fee_correction'"
                    )
                ).fetchone()
            )["amount"] == Decimal("-1.03")
        for request, response in zip((one, two), results):
            assert (await client.get(P + "/operations/" + request["requestId"])).json() == response.json()

        async with db.connection() as conn:
            assert (await(await conn.execute("SELECT count(*) n FROM actual_fee_confirmations")).fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_posting_failure_rolls_back_every_financial_row_and_keeps_original_uuid_failure(client, admin, db, app, old_pg, pg, tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee="1.03") as (client,source_app,grant,exported,aid,fill,data):
        proof = (await client.post(P + "/preview", json=data)).json()
        before = await financial_rows(db)
        async with db.connection() as conn:
            await conn.execute(
                "CREATE FUNCTION synthetic_fee_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic private posting failure'; END $$"
            )
            await conn.execute(
                "CREATE TRIGGER synthetic_fee_failure BEFORE INSERT ON cash_ledger_entries FOR EACH ROW WHEN (NEW.kind='fee_correction') EXECUTE FUNCTION synthetic_fee_failure()"
            )
        body = {"data": data, "preview": proof["previewRevision"]}
        rejected = await client.post(P + "/operations", json=body)
        assert (
            rejected.status_code == 200
            and rejected.json()["state"] == "failed"
            and rejected.json()["status"] == 503
        )
        assert "Synthetic" not in rejected.text and "private" not in rejected.text
        assert await financial_rows(db) == before
        async with db.connection() as conn:
            assert not await (await conn.execute("SELECT 1 FROM trade_fee_corrections")).fetchone()
            assert not await (await conn.execute("SELECT 1 FROM trade_fee_projections")).fetchone()
            await conn.execute("DROP TRIGGER synthetic_fee_failure ON cash_ledger_entries")
        assert (await client.get(P + "/operations/" + data["requestId"])).json() == rejected.json()
        # Returning connectivity does not replay the old UUID or reinterpret its failure.
        assert (await client.post(P + "/operations", json=body)).json() == rejected.json()
        assert await financial_rows(db) == before

        async with db.connection() as conn:
            assert (await(await conn.execute("SELECT count(*) n FROM actual_fee_confirmations")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_deferred_cash_attribution_failure_cannot_escape_success_savepoint(client, admin, db, app, old_pg, pg, tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee="1.03") as (client,source_app,grant,exported,aid,fill,data):
        proof = (await client.post(P + "/preview", json=data)).json()
        before = await financial_rows(db)
        async with db.connection() as conn:
            await conn.execute(
                "CREATE FUNCTION synthetic_deferred_fee_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic deferred attribution failure'; END $$"
            )
            await conn.execute(
                "CREATE CONSTRAINT TRIGGER synthetic_deferred_fee_failure AFTER INSERT ON trade_fee_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_deferred_fee_failure()"
            )
        rejected = await client.post(P + "/operations", json={"data": data, "preview": proof["previewRevision"]})
        assert rejected.status_code == 200 and rejected.json()["state"] == "failed"
        assert await financial_rows(db) == before
        assert (await client.get(P + "/operations/" + data["requestId"])).json() == rejected.json()

        async with db.connection() as conn:
            assert (await(await conn.execute("SELECT count(*) n FROM actual_fee_confirmations")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_expired_preview_records_a_failure_without_posting_and_other_operation_receipt_is_not_fee_repair(client, admin, db, app, old_pg, pg, tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee="1.03") as (client,source_app,grant,exported,aid,fill,data):
        proof = (await client.post(P + "/preview", json=data)).json()
        before = await financial_rows(db)
        async with db.connection() as conn:
            await conn.execute("UPDATE trade_fee_previews SET expires_at=clock_timestamp()-interval '1 second'")
        rejected = await client.post(P + "/operations", json={"data": data, "preview": proof["previewRevision"]})
        assert (
            rejected.status_code == 200
            and rejected.json()["state"] == "failed"
            and rejected.json()["status"] == 409
        )
        assert await financial_rows(db) == before
        assert (await client.get(P + "/operations/" + data["requestId"])).json() == rejected.json()
        assert (await client.get(P + "/operations/" + fill["requestId"])).status_code == 404

        async with db.connection() as conn:
            assert (await(await conn.execute("SELECT count(*) n FROM actual_fee_confirmations")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_db_requires_source_cash_evidence_even_if_application_policy_is_bypassed(client, admin, db, app, old_pg, pg, tmp_path, monkeypatch):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee="1.03") as (client,source_app,grant,exported,aid,fill,data):
        from alcor_api.actual_fee_confirmations import ActualFeeConfirmations as FeeRepairs, parse_actual as parse
        from fee_source_test_helpers import identity

        proof = (await client.post(P + "/preview", json=data)).json()
        before = await financial_rows(db)
        who = await identity(client, db)
        service = FeeRepairs(db,source_app.state.source_authority)
        async with db.connection() as conn:
            cached = await service.calculate(conn, who, parse(data))
            await conn.execute("DELETE FROM fee_legacy_inventory_heads WHERE owner_id=%s", (admin,))

        async def stale_application_policy(*args):
            return cached

        with monkeypatch.context() as patch:
            patch.setattr(FeeRepairs, "calculate", stale_application_policy)
            rejected = await client.post(
                P + "/operations", json={"data": data, "preview": proof["previewRevision"]}
            )
        assert rejected.status_code == 200 and rejected.json()["state"] == "failed"
        assert await financial_rows(db) == before
        assert (await client.get(P + "/operations/" + data["requestId"])).json() == rejected.json()
        async with db.connection() as conn:
            assert not await (await conn.execute("SELECT 1 FROM trade_fee_corrections")).fetchone()

        async with db.connection() as conn:
            assert (await(await conn.execute("SELECT count(*) n FROM actual_fee_confirmations")).fetchone())["n"] == 0
