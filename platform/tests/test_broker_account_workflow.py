"""Deferred single synthetic F07 lifecycle; no provider calls or broker orders."""

from io import BytesIO
from uuid import uuid4

from alcor_api.portfolio_records import PortfolioRecords
from PIL import Image
from test_broker_metadata import ROOT, command, preview
from test_broker_statement_integration import BASE, XML
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_portfolio_records import create as create_record

SOURCE = "/api/account/broker-holding-source"
ICONS = "/api/account/broker-icons"


async def test_broker_account_complete_owner_workflow(client, admin, db):
    async def post(path, body):
        result = await client.post(path, json=body)
        assert result.status_code == 200, result.text
        return result.json()

    value = await command(client)
    created = await post(ROOT + "/operations", await preview(client, value))
    assert created["state"] == "completed"
    identifier = created["data"]["id"]
    assert (await client.get(ROOT + "/operations/" + value["data"]["request_id"])).json() == created
    # An intervening directory write invalidates the old account create proof.
    stale_command = await command(client)
    stale_command["data"]["name"] = "Synthetic stale directory candidate"
    stale_directory = await preview(client, stale_command)
    image = BytesIO()
    Image.new("RGB", (16, 16), "blue").save(image, format="PNG")
    upload_id = str(uuid4())
    upload = await client.post(
        ICONS + "/" + identifier,
        data={"requestId": upload_id, "revision": "1"},
        files={"file": ("synthetic.png", image.getvalue(), "image/png")},
    )
    assert upload.status_code == 200, upload.text
    uploaded = upload.json()
    assert uploaded["state"] == "completed" and uploaded["data"]["iconVersion"]
    content = await client.get(ICONS + "/" + identifier + "/content")
    assert content.status_code == 200 and content.content.startswith(b"\x89PNG")
    assert (await client.get(ICONS + "/operations/" + upload_id)).json() == uploaded
    assert (await client.post(ROOT + "/operations", json=stale_directory)).status_code == 409
    reset_id = str(uuid4())
    reset = await client.request(
        "DELETE",
        ICONS + "/" + identifier,
        json={"requestId": reset_id, "revision": uploaded["data"]["revision"]},
    )
    assert reset.status_code == 200 and reset.json()["state"] == "completed", reset.text
    assert reset.json()["data"]["iconVersion"] is None
    assert (await client.get(ICONS + "/" + identifier + "/content")).status_code == 404
    revision = reset.json()["data"]["revision"]
    # Preserve an actual zero cash opening independently of reported cash.
    await cash_submit(client, cash_command(identifier, amount="0"))
    statement = await post(
        BASE + "/preview",
        {
            "requestId": str(uuid4()),
            "accountId": identifier,
            "accountKind": "real",
            "revision": revision,
            "externalAccount": "SYNTHETIC",
            "xml": XML,
        },
    )
    await post(
        BASE + "/imports",
        {
            "requestId": str(uuid4()),
            "previewId": statement["previewId"],
            "confirmExternalAccount": "SYNTHETIC",
            "takeOverOfficial": True,
            "acknowledgeUnassigned": True,
        },
    )

    async def source_command():
        response = await client.get(SOURCE)
        assert response.status_code == 200, response.text
        state = response.json()
        account = next(row for row in state["accounts"] if row["id"] == identifier)
        return {
            "kind": "holding-source",
            "accountId": identifier,
            "expectedCollectionRevision": state["collectionRevision"],
            "expectedRecordCollectionRevision": state["recordCollectionRevision"],
            "data": {
                "requestId": str(uuid4()),
                "revision": account["revision"],
                "accountKind": "real",
                "source": "manual",
            },
        }

    stale = await source_command()
    stale_proof = await post(SOURCE + "/preview", stale)
    await create_record(PortfolioRecords(db), admin, code="OTHER", cost=None)
    assert (
        await client.post(
            SOURCE + "/operations",
            json={
                "previewId": stale_proof["previewId"],
                "command": stale,
                "acknowledgeProjectionChange": True,
            },
        )
    ).status_code == 409
    change = await source_command()
    proof = await post(SOURCE + "/preview", change)
    position = next(row for row in proof["records"] if row["security"] == "US:SYNTH")
    assert position["official"]["qty"] == "2" and position["manual"]["qty"] is None
    completed = await post(
        SOURCE + "/operations",
        {"previewId": proof["previewId"], "command": change, "acknowledgeProjectionChange": True},
    )
    assert completed["state"] == "completed" and completed["data"]["snapshotsRetained"]
    assert (
        completed["data"]["sourceConfigurationRetained"]
        and completed["data"]["pendingContinuationInvalidated"]
    )
    assert (await client.get(SOURCE + "/operations/" + change["data"]["requestId"])).json() == completed
    original = await client.get(BASE + "/originals/" + statement["originalId"])
    assert original.content == XML.encode()
    record = next(
        row
        for row in (await client.get("/api/portfolio/records")).json()["records"]
        if row["brokerAccountId"] == identifier
    )
    assert record["qty"] is None and not record.get("officialObservation")
    late = await command(client)
    late["data"]["name"] = "Synthetic closed late account"
    late_proof = await preview(client, late)
    closed = await post(ROOT + "/operations/" + late["data"]["request_id"] + "/close", {})
    assert closed["state"] == "closed" and closed["executed"] is False
    assert await post(ROOT + "/operations", late_proof) == closed
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s",
                    (admin, identifier),
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_icon_versions WHERE owner_id=%s AND account_id=%s",
                    (admin, identifier),
                )
            ).fetchone()
        )["n"] == 1
        ledger = await (
            await conn.execute(
                "SELECT amount FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s",
                (admin, identifier),
            )
        ).fetchall()
        assert len(ledger) == 1 and ledger[0]["amount"] == 0
        assert not await (
            await conn.execute("SELECT 1 FROM trade_ledger WHERE owner_id=%s", (admin,))
        ).fetchone()


async def test_actual_buy_full_transfer_then_target_sell_preserves_original_history(client, admin, db):
    from test_cash_ledger import account
    from test_trading import command as trade_command
    from test_trading import setup as trading_setup
    from test_trading import submit as trade_submit

    source_id, initial = await trading_setup(client, name="Synthetic transfer source")
    bought, _ = await trade_submit(client, trade_command(initial))
    record = bought["record"]
    target_id = await account(client, name="Synthetic transfer target")
    # This opening follows the source buy cash revision; do not backdate across owner cash.
    await cash_submit(client, cash_command(target_id, amount="0", occurredAt="2026-01-02T12:00:00Z"))
    async with db.connection() as conn:
        original_trades = await (
            await conn.execute(
                "SELECT id,record_id,account_id,quantity,amount,fees FROM trade_ledger WHERE owner_id=%s ORDER BY id",
                (admin,),
            )
        ).fetchall()
        original_cash = await (
            await conn.execute(
                "SELECT id,account_id,amount FROM cash_ledger_entries WHERE owner_id=%s ORDER BY id", (admin,)
            )
        ).fetchall()
    root = "/api/account/broker-position-transfers"
    state_response = await client.get(root)
    assert state_response.status_code == 200, state_response.text
    state = state_response.json()
    accounts = {row["id"]: row for row in state["accounts"]}
    eligible = next(row for row in state["records"] if row["id"] == record["id"])
    assert eligible["actualKnown"] and eligible["qty"] == "2"
    command = {
        "requestId": str(uuid4()),
        "sourceRecordId": record["id"],
        "sourceRecordRevision": eligible["revision"],
        "sourceAccountId": source_id,
        "sourceAccountRevision": accounts[source_id]["revision"],
        "targetAccountId": target_id,
        "targetAccountRevision": accounts[target_id]["revision"],
        "accountKind": "real",
        "quantity": eligible["qty"],
        "expectedRecordCollectionRevision": state["recordCollectionRevision"],
        "evidence": {
            "kind": "owner_recorded_transfer",
            "reference": "synthetic custodian transfer reference",
            "occurredAt": "2026-01-03T00:00:00Z",
        },
    }
    preview_response = await client.post(root + "/preview", json=command)
    assert preview_response.status_code == 200, preview_response.text
    preview = preview_response.json()
    assert preview["sourceBefore"]["qty"] == "2" and preview["sourceAfter"]["qty"] == "0"
    assert preview["targetBefore"] is None and preview["targetAfter"]["qty"] == "2"
    assert preview["cashEffect"] == "none"
    body = {"previewId": preview["previewId"], "command": command, "confirmTransfer": True}
    confirmed = await client.post(root + "/operations", json=body)
    assert confirmed.status_code == 200, confirmed.text
    receipt = confirmed.json()
    assert receipt["state"] == "completed" and receipt["targetRecordId"] != record["id"]
    assert (await client.post(root + "/operations", json=body)).json() == receipt
    assert (await client.get(root + "/operations/" + command["requestId"])).json() == receipt
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT id,record_id,account_id,quantity,amount,fees FROM trade_ledger WHERE owner_id=%s ORDER BY id",
                    (admin,),
                )
            ).fetchall()
            == original_trades
        )
        assert (
            await (
                await conn.execute(
                    "SELECT id,account_id,amount FROM cash_ledger_entries WHERE owner_id=%s ORDER BY id",
                    (admin,),
                )
            ).fetchall()
            == original_cash
        )
        retained = await (
            await conn.execute(
                "SELECT broker_account_id,qty FROM portfolio_records WHERE owner_id=%s AND id=%s",
                (admin, record["id"]),
            )
        ).fetchone()
        assert retained["broker_account_id"] == source_id and retained["qty"] == 0
    target_response = await client.get("/api/portfolio/records/" + receipt["targetRecordId"])
    assert target_response.status_code == 200, target_response.text
    target_record = target_response.json()["record"]
    sold, _ = await trade_submit(
        client,
        trade_command(
            target_record,
            side="sell",
            quantity="1",
            price="12",
            amount="12",
            fees="0",
            occurredAt="2026-01-04T00:00:00Z",
        ),
    )
    assert sold["record"]["qty"] == "1" and sold["record"]["brokerAccountId"] == target_id
    async with db.connection() as conn:
        retained_trade = await (
            await conn.execute(
                "SELECT record_id,account_id FROM trade_ledger WHERE owner_id=%s AND id=%s",
                (admin, original_trades[0]["id"]),
            )
        ).fetchone()
        assert retained_trade["record_id"] == record["id"] and retained_trade["account_id"] == source_id
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_position_transfer_events WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 2


async def test_account_uuid_cannot_authorize_import_source_or_transfer(client, admin, db, settings):
    from test_cash_ledger import account
    from test_trading import command as trade_command
    from test_trading import setup as trading_setup
    from test_trading import submit as trade_submit

    source_id, initial = await trading_setup(client, name="Synthetic UUID source", code="SYNTH")
    bought, _ = await trade_submit(client, trade_command(initial))
    target_id = await account(client, name="Synthetic UUID target")
    async with db.connection() as conn:
        existing = await (
            await conn.execute(
                "SELECT request_id FROM broker_account_operations WHERE owner_id=%s AND result->>'account_id'=%s AND result->>'kind'='create'",
                (admin, source_id),
            )
        ).fetchone()
        reused = str(existing["request_id"])
    state = (await client.get(ROOT)).json()
    source = next(row for row in state["accounts"] if row["id"] == source_id)
    statement_response = await client.post(
        BASE + "/preview",
        json={
            "requestId": str(uuid4()),
            "accountId": source_id,
            "accountKind": "real",
            "revision": source["revision"],
            "externalAccount": "SYNTHETIC",
            "xml": XML,
        },
    )
    assert statement_response.status_code == 200, statement_response.text
    statement = statement_response.json()
    transfer_root = "/api/account/broker-position-transfers"
    transfer_state = (await client.get(transfer_root)).json()
    accounts = {row["id"]: row for row in transfer_state["accounts"]}
    record = next(row for row in transfer_state["records"] if row["id"] == bought["record"]["id"])
    transfer_command = {
        "requestId": reused,
        "sourceRecordId": record["id"],
        "sourceRecordRevision": record["revision"],
        "sourceAccountId": source_id,
        "sourceAccountRevision": accounts[source_id]["revision"],
        "targetAccountId": target_id,
        "targetAccountRevision": accounts[target_id]["revision"],
        "accountKind": "real",
        "quantity": record["qty"],
        "expectedRecordCollectionRevision": transfer_state["recordCollectionRevision"],
        "evidence": {
            "kind": "owner_recorded_transfer",
            "reference": "synthetic UUID isolation",
            "occurredAt": "2026-01-03T00:00:00Z",
        },
    }
    transfer_preview = await client.post(transfer_root + "/preview", json=transfer_command)
    assert transfer_preview.status_code == 200, transfer_preview.text
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

    async def business_snapshot():
        tables = (
            "broker_accounts",
            "broker_account_collections",
            "portfolio_records",
            "portfolio_record_collections",
            "trade_ledger",
            "cash_ledger_entries",
            "broker_statement_imports",
            "broker_statement_positions",
            "broker_statement_events",
            "broker_statement_import_operations",
            "broker_statement_sources",
            "broker_statement_source_attempts",
            "broker_position_transfers",
            "broker_position_transfer_events",
            "broker_position_transfer_operations",
            "broker_request_domains",
        )
        async with db.connection() as conn:
            return {
                table: await (
                    await conn.execute(
                        "SELECT to_jsonb(t) AS value FROM "
                        + table
                        + " t WHERE owner_id=%s ORDER BY to_jsonb(t)::text",
                        (admin,),
                    )
                ).fetchall()
                for table in tables
            }

    before = await business_snapshot()
    commands = [
        (
            BASE + "/imports",
            {
                "requestId": reused,
                "previewId": statement["previewId"],
                "confirmExternalAccount": "SYNTHETIC",
                "takeOverOfficial": True,
                "acknowledgeUnassigned": True,
            },
        ),
        (
            BASE + "/accounts/" + source_id + "/source",
            {
                "requestId": reused,
                "accountKind": "real",
                "accountRevision": source["revision"],
                "connectionRevision": 0,
                "targetId": "synthetic",
                "externalAccount": "SYNTHETIC",
                "queryId": "123",
                "token": "SYNTHETICTOKEN12345",
            },
        ),
        (
            transfer_root + "/operations",
            {
                "previewId": transfer_preview.json()["previewId"],
                "command": transfer_command,
                "confirmTransfer": True,
            },
        ),
    ]
    for path, body in commands:
        result = await client.post(path, json=body)
        assert result.status_code == 409, result.text
        assert await business_snapshot() == before
    original = await client.get(ROOT + "/operations/" + reused)
    assert original.status_code == 200 and original.json()["kind"] == "create"


async def test_shared_broker_directory_http_updates_only_unassigned_labels(client, admin, db):
    from test_cash_ledger import account

    root = "/api/admin/shared-brokers"

    async def state():
        response = await client.get(root)
        assert response.status_code == 200, response.text
        return response.json()

    async def prepare(command):
        response = await client.post(root + "/preview", json=command)
        assert response.status_code == 200, response.text
        return {**command, "previewId": response.json()["previewId"]}, response.json()

    async def submit(body):
        response = await client.post(root + "/operations", json=body)
        assert response.status_code == 200, response.text
        return response.json()

    initial = await state()
    old_name = "Synthetic shared original"
    new_name = "Synthetic shared renamed"
    group_id = "shared-" + uuid4().hex
    seed = {
        "requestId": str(uuid4()),
        "expectedRevision": initial["revision"],
        "groups": [*initial["groups"], {"id": group_id, "name": old_name, "alias": "Synthetic alias"}],
    }
    seed_body, _ = await prepare(seed)
    await submit(seed_body)
    personal_account = await account(client, name=old_name)
    service = PortfolioRecords(db)
    unassigned = (await create_record(service, admin, code="UNBOUND", group=old_name, qty="0", cost=None))[
        "record"
    ]
    assigned = (
        await create_record(
            service, admin, code="BOUND", brokerAccountId=personal_account, group=old_name, qty="0", cost=None
        )
    )["record"]
    current = await state()
    groups = [{**row, "name": new_name} if row["id"] == group_id else row for row in current["groups"]]
    command = {"requestId": str(uuid4()), "expectedRevision": current["revision"], "groups": groups}
    body, plan = await prepare(command)
    assert plan["renamed"] == [{"id": group_id, "from": old_name, "to": new_name}]
    assert plan["affectedUnassignedRecords"] == 1 and plan["financialFieldsChanged"] is False
    saved = await submit(body)
    assert saved["state"] == "completed" and saved["originalsDeleted"] is False
    assert await submit(body) == saved
    assert (await client.get(root + "/operations/" + command["requestId"])).json() == saved
    assert (
        await client.post(root + "/operations/" + command["requestId"] + "/close", json={})
    ).json() == saved
    stale = await client.post(root + "/preview", json={**command, "requestId": str(uuid4())})
    assert stale.status_code == 409, stale.text
    latest = await state()
    late_command = {
        "requestId": str(uuid4()),
        "expectedRevision": latest["revision"],
        "groups": latest["groups"],
    }
    late_body, _ = await prepare(late_command)
    closed = await client.post(root + "/operations/" + late_command["requestId"] + "/close", json={})
    assert closed.status_code == 200 and closed.json()["state"] == "closed", closed.text
    assert await submit(late_body) == closed.json()
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT id,group_name,broker_account_id,qty,cost FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s)",
                (admin, [unassigned["id"], assigned["id"]]),
            )
        ).fetchall()
        by_id = {row["id"]: row for row in rows}
        assert (
            by_id[unassigned["id"]]["group_name"] == new_name
            and by_id[unassigned["id"]]["broker_account_id"] is None
        )
        assert (
            by_id[assigned["id"]]["group_name"] == old_name
            and by_id[assigned["id"]]["broker_account_id"] == personal_account
        )
        assert all(row["qty"] == 0 and row["cost"] is None for row in rows)
        personal = await (
            await conn.execute(
                "SELECT name FROM broker_accounts WHERE owner_id=%s AND id=%s", (admin, personal_account)
            )
        ).fetchone()
        assert personal["name"] == old_name
