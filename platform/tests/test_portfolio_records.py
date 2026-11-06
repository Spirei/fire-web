import asyncio
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from alcor_api.cli import create_user
from alcor_api.portfolio_records import PortfolioRecords, normalize
from alcor_api.watchlists import WatchGroups
from fastapi import HTTPException


def fields(**changes):
    return {"name": "Example", "code": "AAPL", "market": "US", "price": None, "cost": "-2.005", "qty": "0", "group": "", "note": "", **changes}


async def owner(settings, name="PortfolioOwner"):
    return await create_user(settings, name, "Synthetic9Pass", email=name.lower() + "@example.invalid")


async def create(service, who, **changes):
    preview = await service.preview(who, "create", fields(**changes))
    return await service.confirm(who, preview["previewId"], uuid4())


@pytest.mark.asyncio
async def test_preview_commit_decimal_missing_and_duplicate_uuid(settings, db):
    who = await owner(settings)
    service = PortfolioRecords(db)
    preview = await service.preview(who, "create", fields(price="0", qty=None))
    assert (await service.list(who))["total"] == 0
    request = uuid4()
    result = await service.confirm(who, preview["previewId"], request)
    assert result["record"]["price"] == "0"
    assert result["record"]["qty"] is None
    assert result["record"]["cost"] == "-2.005"
    with pytest.raises(HTTPException) as error:
        await service.confirm(who, preview["previewId"], request)
    assert error.value.status_code == 409
    assert await service.receipt(who, request) == result
    assert (await service.list(who))["total"] == 1


@pytest.mark.asyncio
async def test_stale_preview_and_concurrent_confirm_do_not_double_write(settings, db):
    who = await owner(settings)
    service = PortfolioRecords(db)
    stale = await service.preview(who, "create", fields(code="MSFT"))
    current = await service.preview(who, "create", fields())
    outcomes = await asyncio.gather(*(service.confirm(who, current["previewId"], uuid4()) for _ in range(2)), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in outcomes) == 1
    assert sum(isinstance(r, HTTPException) and r.status_code == 409 for r in outcomes) == 1
    with pytest.raises(HTTPException) as error:
        await service.confirm(who, stale["previewId"], uuid4())
    assert error.value.status_code == 409
    assert (await service.list(who))["total"] == 1


@pytest.mark.asyncio
async def test_owned_reads_preview_expiry_and_direct_writer_revision(settings, db):
    who, other = await owner(settings), await owner(settings, "PortfolioOther")
    service = PortfolioRecords(db)
    result = await create(service, who)
    record = result["record"]
    with pytest.raises(HTTPException) as error:
        await service.preview(other, "delete", {}, record_id=record["id"], revision=record["revision"])
    assert error.value.status_code == 404
    assert (await service.list(other))["records"] == []
    preview = await service.preview(who, "delete", {}, record_id=record["id"], revision=record["revision"])
    async with db.connection() as conn:
        await conn.execute("UPDATE portfolio_record_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=%s", (who,))
    with pytest.raises(HTTPException):
        await service.confirm(who, preview["previewId"], uuid4())
    async with db.connection() as conn:
        await conn.execute("UPDATE portfolio_records SET note='Independent writer' WHERE owner_id=%s AND id=%s", (who, record["id"]))
    assert (await service.list(who))["records"][0]["revision"] == record["revision"] + 1
    with pytest.raises(HTTPException):
        await service.list(who, collection_revision=result["collectionRevision"])


@pytest.mark.asyncio
async def test_delete_guards_history_and_nonzero_position(settings, db):
    who = await owner(settings)
    service = PortfolioRecords(db)
    record = (await create(service, who, qty="1"))["record"]
    with pytest.raises(HTTPException) as error:
        await service.preview(who, "delete", {}, record_id=record["id"], revision=record["revision"])
    assert error.value.status_code == 409
    async with db.connection() as conn:
        await conn.execute("UPDATE portfolio_records SET qty=0,history_state='unknown' WHERE owner_id=%s AND id=%s", (who, record["id"]))
    record = (await service.list(who))["records"][0]
    with pytest.raises(HTTPException) as error:
        await service.preview(who, "delete", {}, record_id=record["id"], revision=record["revision"])
    assert error.value.status_code == 409
    async with db.connection() as conn:
        await conn.execute("UPDATE portfolio_records SET history_state='empty' WHERE owner_id=%s AND id=%s", (who, record["id"]))
    record = (await service.list(who))["records"][0]
    preview = await service.preview(who, "delete", {}, record_id=record["id"], revision=record["revision"])
    deleted = await service.confirm(who, preview["previewId"], uuid4())
    assert deleted["deleted"] and (await service.list(who))["total"] == 0
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT deleted_at,revision FROM portfolio_records WHERE owner_id=%s AND id=%s", (who, record["id"]))).fetchone()
        assert row["deleted_at"] is not None and row["revision"] == deleted["revision"]
        with pytest.raises(Exception, match="tombstone"):
            await conn.execute("DELETE FROM portfolio_records WHERE owner_id=%s", (who,))


@pytest.mark.asyncio
async def test_group_deletion_unlinks_same_record_and_bumps_version(settings, db):
    who = await owner(settings)
    groups, records = WatchGroups(db), PortfolioRecords(db)
    group = (await groups.mutate(who, "create", {"name": "Favorites"}, uuid4()))["group"]
    record = (await create(records, who, watchGroupId=group["id"]))["record"]
    await groups.mutate(who, "delete", {"id": group["id"]}, uuid4())
    current = (await records.list(who))["records"][0]
    assert current["id"] == record["id"]
    assert current["watchGroupId"] == "" and current["revision"] == record["revision"] + 1


def test_input_identity_and_decimal_guards():
    data = normalize(fields(code="HK.700", market="HK", accountMarket="CN", price="123.456789123456789123"))
    assert data["code"] == "00700" and data["market"] == "HK" and data["accountMarket"] == "CN"
    assert Decimal(data["price"]) == Decimal("123.456789123456789123")
    for changes in ({"price": 0.1}, {"price": "NaN"}, {"qty": -1}, {"cost": "Infinity"}, {"price": True}, {"market": "US", "accountMarket": "CN"}, {"code": "HK.700", "market": "US"}):
        with pytest.raises(HTTPException):
            normalize(fields(**changes))


async def account(db, who, *, source="manual"):
    account_id = "ba-" + uuid4().hex[:24]
    async with db.connection() as conn:
        await conn.execute("INSERT INTO broker_accounts(id,owner_id,name,account_kind,holding_source,currency,currencies) VALUES(%s,%s,%s,'real',%s,'USD',ARRAY['USD','HKD'])", (account_id, who, account_id, source))
    return account_id


@pytest.mark.asyncio
async def test_broker_identity_source_references_and_dependency_change(settings, db):
    who, other = await owner(settings), await owner(settings, "PortfolioOther")
    account_id, foreign = await account(db, who), await account(db, other)
    service = PortfolioRecords(db)
    with pytest.raises(HTTPException) as error:
        await service.preview(who, "create", fields(brokerAccountId=foreign))
    assert error.value.status_code == 404
    stale = await service.preview(who, "create", fields(brokerAccountId=account_id))
    async with db.connection() as conn:
        await conn.execute("UPDATE broker_accounts SET name='Renamed',revision=revision+1 WHERE id=%s", (account_id,))
    with pytest.raises(HTTPException) as error:
        await service.confirm(who, stale["previewId"], uuid4())
    assert error.value.status_code == 409
    record = (await create(service, who, brokerAccountId=account_id))["record"]
    assert record["group"] == "Renamed"
    async with db.connection() as conn:
        refs = await (await conn.execute("SELECT kind,reference_id,currency FROM broker_account_references WHERE owner_id=%s AND account_id=%s", (who, account_id))).fetchall()
        assert refs == [{"kind": "position", "reference_id": record["id"], "currency": None}]
    with pytest.raises(HTTPException) as error:
        await service.preview(who, "create", fields(code="US.AAPL", brokerAccountId=account_id))
    assert error.value.status_code == 409
    update = await service.preview(who, "update", fields(group="Stale label", note="metadata"), record_id=record["id"], revision=record["revision"])
    assert update["after"]["brokerAccountId"] == account_id and update["after"]["group"] == "Renamed"
    async with db.connection() as conn:
        await conn.execute("UPDATE broker_accounts SET holding_source='official',revision=revision+1 WHERE id=%s", (account_id,))
    with pytest.raises(HTTPException) as error:
        await service.confirm(who, update["previewId"], uuid4())
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        await service.preview(who, "update", fields(brokerAccountId=""), record_id=record["id"], revision=record["revision"])


@pytest.mark.asyncio
async def test_receipt_failure_rolls_back_record_reference_preview_and_audit(settings, db):
    who = await owner(settings)
    account_id = await account(db, who)
    service = PortfolioRecords(db)
    preview = await service.preview(who, "create", fields(brokerAccountId=account_id))
    request_id = uuid4()
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION reject_portfolio_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$")
        await conn.execute("CREATE TRIGGER reject_portfolio_receipt BEFORE INSERT ON portfolio_record_operations FOR EACH ROW EXECUTE FUNCTION reject_portfolio_receipt()")
    with pytest.raises(Exception, match="synthetic receipt failure"):
        await service.confirm(who, preview["previewId"], request_id)
    assert (await service.list(who))["total"] == 0
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM broker_account_references WHERE owner_id=%s", (who,))).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT consumed_at FROM portfolio_record_previews WHERE owner_id=%s AND id=%s", (who, UUID(preview["previewId"])))).fetchone())["consumed_at"] is None
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE request_id=%s", (request_id,))).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_http_preview_confirm_csrf_and_original_receipt(app, client, admin):
    initial = await client.get("/api/portfolio/records")
    assert initial.status_code == 200
    preview = await client.post("/api/portfolio/records/preview", json={"kind": "create", "data": fields()})
    assert preview.status_code == 200, preview.text
    payload = {"previewId": preview.json()["previewId"], "requestId": str(uuid4())}
    denied = await client.post("/api/portfolio/records/confirm", json=payload, headers={"x-csrf-token": "wrong"})
    assert denied.status_code == 403
    result = await client.post("/api/portfolio/records/confirm", json=payload)
    assert result.status_code == 200, result.text
    duplicate = await client.post("/api/portfolio/records/confirm", json=payload)
    assert duplicate.status_code == 409
    receipt = await client.get("/api/portfolio/records/operations/" + payload["requestId"])
    assert receipt.json() == result.json()
    assert (await client.get("/api/portfolio/records")).json()["records"][0]["id"] == result.json()["recordId"]
    client.cookies.clear()
    assert (await client.get("/api/portfolio/records/operations/" + payload["requestId"])).status_code == 401


@pytest.mark.asyncio
async def test_previews_are_bound_to_originating_authenticated_session(app, client, admin):
    preview = await client.post("/api/portfolio/records/preview", json={"kind": "create", "data": fields()})
    assert preview.status_code == 200
    login = await client.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    assert login.status_code == 200
    client.headers["x-csrf-token"] = login.json()["csrf"]
    result = await client.post("/api/portfolio/records/confirm", json={"previewId": preview.json()["previewId"], "requestId": str(uuid4())})
    assert result.status_code == 409
    assert (await client.get("/api/portfolio/records")).json()["total"] == 0


@pytest.mark.asyncio
async def test_assign_reorder_views_and_unmodified_observation_times(settings, db):
    who = await owner(settings)
    groups, records = WatchGroups(db), PortfolioRecords(db)
    group = (await groups.mutate(who, "create", {"name": "Favorites"}, uuid4()))["group"]
    first = (await create(records, who))["record"]
    second = (await create(records, who, code="MSFT"))["record"]
    before = await records.list(who)
    ids = [first["id"], second["id"]]
    assigned = await groups.mutate(who, "assign", {"ids": ids, "groupId": group["id"], "collectionRevision": before["collectionRevision"]}, uuid4())
    current = await records.list(who, view=group["id"])
    assert [r["id"] for r in current["records"]] == ids
    assert current["collectionRevision"] == assigned["collectionRevision"]
    assert {r["id"]: r["updatedAt"] for r in current["records"]} == {r["id"]: r["updatedAt"] for r in before["records"]}
    with pytest.raises(HTTPException):
        await groups.mutate(who, "reorder-records", {"ids": ids[:1], "groupId": group["id"], "collectionRevision": current["collectionRevision"]}, uuid4())
    reordered = await groups.mutate(who, "reorder-records", {"ids": ids[::-1], "groupId": group["id"], "collectionRevision": current["collectionRevision"]}, uuid4())
    assert [r["id"] for r in (await records.list(who, view=group["id"]))["records"]] == ids[::-1]
    await groups.mutate(who, "reorder-records", {"ids": ids, "groupId": "__all", "collectionRevision": reordered["collectionRevision"]}, uuid4())
    all_records = await records.list(who)
    assert [r["id"] for r in all_records["records"]] == ids
    assert {r["id"]: r["updatedAt"] for r in all_records["records"]} == {r["id"]: r["updatedAt"] for r in before["records"]}
    assert [r["id"] for r in (await records.list(who, view=group["id"]))["records"]] == ids[::-1]


@pytest.mark.asyncio
async def test_trade_history_disallows_financial_rewrite_but_allows_note(settings, db):
    who = await owner(settings)
    service = PortfolioRecords(db)
    record = (await create(service, who))["record"]
    async with db.connection() as conn:
        await conn.execute("UPDATE portfolio_records SET history_state='has_trades' WHERE owner_id=%s AND id=%s", (who, record["id"]))
    record = (await service.list(who))["records"][0]
    for changes in ({"qty": "2"}, {"cost": "99"}, {"code": "MSFT"}, {"source": "official"}):
        with pytest.raises(HTTPException) as error:
            await service.preview(who, "update", fields(**changes), record_id=record["id"], revision=record["revision"])
        assert error.value.status_code == 409
    preview = await service.preview(who, "update", fields(note="Personal note"), record_id=record["id"], revision=record["revision"])
    result = await service.confirm(who, preview["previewId"], uuid4())
    assert result["record"]["note"] == "Personal note" and result["record"]["historyState"] == "has_trades"
