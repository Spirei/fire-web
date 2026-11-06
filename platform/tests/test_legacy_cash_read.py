"""Pure DTO/source checks; none of these tests starts PostgreSQL or Swift."""

import copy
import json
import subprocess
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from alcor_api.legacy_cash_read import error_body, history_dto, history_query, history_read, snapshot_dto
from fastapi import HTTPException
from starlette.datastructures import QueryParams

AT = datetime(2020, 1, 1, tzinfo=UTC)
ACCOUNT = {
    "id": "ba-" + "1" * 24,
    "revision": 2,
    "holding_source": "manual",
    "account_kind": "real",
    "currencies": ["USD"],
}


def inputs(kind):
    initialized = kind != "uninitialized"
    opening = {"opening_at": AT, "opening_basis": "new_external_opening"} if initialized else None
    known = kind in ("zero", "official")
    snapshot = {
        "revision": 7,
        "currencies": [
            {
                "currency": "USD",
                "opening": opening,
                "balance": "0" if known else None,
                "registeredBalance": "0" if initialized else None,
                "complete": known,
            }
        ],
    }
    activity = {
        "openingAmount": Decimal(0),
        "externalDeposits": Decimal(0),
        "externalWithdrawals": Decimal(0),
        "netExternalFlow": Decimal(0),
        "tradeNetFlow": Decimal(0),
        "entryCount": 1,
    }
    facts = {"USD": {"openingAmount": Decimal(0), "activity": activity}} if initialized else {}
    account = {**ACCOUNT, "holding_source": "official" if kind == "official" else "manual"}
    return account, snapshot, facts


@pytest.mark.parametrize("kind", ["uninitialized", "zero", "incomplete"])
def test_cash_dto_matches_original_node_projector_without_computing_balances(kind):
    account, snapshot, facts = inputs(kind)
    current = snapshot_dto(
        "synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT
    )
    opening = snapshot["currencies"][0]["opening"]
    row = (
        {
            "currency": "USD",
            "revision": 7,
            "opening_amount": 0,
            "opening_at": "2020-01-01T00:00:00.000Z",
            "opening_basis": "new_external_opening",
        }
        if opening
        else None
    )
    payload = {
        "owner": "synthetic",
        "account": {
            "id": account["id"],
            "revision": 2,
            "holdingSource": account["holding_source"],
            "currencies": ["USD"],
        },
        "cashRows": [row] if row else [],
        "ledgers": {
            "USD": {
                "row": row,
                "balance": 0 if snapshot["currencies"][0]["complete"] else None,
                "activity": {key: int(value) for key, value in facts["USD"]["activity"].items()}
                if kind in ("zero", "official")
                else None,
            }
        },
        "observedAt": "2020-01-01T00:00:00.000Z",
    }
    run = subprocess.run(
        ["node", str(Path(__file__).with_name("broker_cash_read_source.cjs"))],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    original = json.loads(run.stdout)
    assert current.pop("accountKind") == "real"
    assert current.pop("historicalCoverageKnown") is False
    assert current.pop("coverageScope") == "platform_registered_cash_only"
    assert current.pop("activityCoverageScope") == "platform_posted_events_including_corrections"
    assert current.pop("withdrawalCapacityKnown") is False
    for key in ("globalCashRevision", "snapshotRevision"):
        assert len(current.pop(key)) == 64
        original.pop(key)
    assert current["currencies"][0].pop("registeredBalance") == (0 if opening else None)
    book_capacity=current['currencies'][0].pop('ledgerWithdrawalCapacity')
    assert book_capacity['amount'] is None and book_capacity['reservedBuyCash'] is None and book_capacity['complete'] is False
    assert book_capacity['coverageScope']=='platform_owner_kind_cash'
    assert current == original


def test_official_snapshot_uses_reported_cash_not_a_registered_ledger_zero():
    account, snapshot, facts = inputs("official")
    observation = {"state": "reported", "authority": "official_statement_snapshot", "asOf": "2026-01-31", "sourceSha256": "a" * 64}
    snapshot["currencies"][0].update(opening=None, balance="12.5", officialObservation=observation, configured=True, sourceOnly=False)
    value = snapshot_dto("synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT)
    row = value["currencies"][0]
    assert row["state"] == "official_readonly" and row["balance"] == 12.5
    assert row["registeredBalance"] == 0 and row["opening"] is None
    assert row["activity"] is None and row["complete"] is False
    assert row["officialObservation"] == observation and row["configured"] is True and row["sourceOnly"] is False
    assert row["withdrawalCapacity"]["amount"] is None
    snapshot["currencies"][0].update(balance=None, complete=False, officialObservation={**observation, "state": "unavailable", "asOf": None, "sourceSha256": None})
    unknown = snapshot_dto("synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT)
    assert unknown["currencies"][0]["balance"] is None
    del snapshot["currencies"][0]["officialObservation"]
    with pytest.raises(HTTPException) as missing:
        snapshot_dto("synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT)
    assert missing.value.status_code == 503


def test_unknown_does_not_become_zero_and_opening_is_never_inferred_from_balance():
    account, snapshot, facts = inputs("uninitialized")
    snapshot["currencies"][0].update(balance="0", registeredBalance="0", complete=True)
    current = snapshot_dto(
        "synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT
    )
    row = current["currencies"][0]
    assert row["balance"] is None and row["opening"] is None and row["complete"] is False
    assert row["activity"] is None and row["withdrawalCapacity"]["amount"] is None
    account, snapshot, facts = inputs("zero")
    with pytest.raises(HTTPException) as error:
        snapshot_dto("synthetic", account, snapshot, {}, instance="isolated-instance", observed_at=AT)
    assert error.value.status_code == 503


def test_cash_scope_hashes_bind_kind_instance_and_revision_and_unsafe_numbers_fail_closed():
    account, snapshot, facts = inputs("zero")
    baseline = snapshot_dto(
        "synthetic", account, snapshot, facts, instance="isolated-instance", observed_at=AT
    )
    for other, instance in (
        ({**account, "account_kind": "simulated"}, "isolated-instance"),
        (account, "restored-instance"),
    ):
        result = snapshot_dto("synthetic", other, snapshot, facts, instance=instance, observed_at=AT)
        assert result["globalCashRevision"] != baseline["globalCashRevision"]
        assert result["snapshotRevision"] != baseline["snapshotRevision"]
    unverified = copy.deepcopy(snapshot)
    unverified["currencies"][0].update(balance=None, complete=False)
    unknown = snapshot_dto(
        "synthetic", account, unverified, facts, instance="isolated-instance", observed_at=AT
    )
    # Source/fee authority can change without a new cash posting. Bind the
    # actual read projection as well as the posted-event version.
    assert unknown["globalCashRevision"] == baseline["globalCashRevision"]
    assert unknown["snapshotRevision"] != baseline["snapshotRevision"]
    changed = copy.deepcopy(snapshot)
    changed["revision"] = 8
    assert (
        snapshot_dto("synthetic", account, changed, facts, instance="isolated-instance", observed_at=AT)[
            "snapshotRevision"
        ]
        != baseline["snapshotRevision"]
    )
    changed["currencies"][0]["balance"] = "0.123456789123456789"
    with pytest.raises(HTTPException) as error:
        snapshot_dto("synthetic", account, changed, facts, instance="isolated-instance", observed_at=AT)
    assert error.value.status_code == 409


def cash_history_page():
    def entry(identifier, kind, amount):
        return {
            "id": identifier,
            "requestId": "11111111-1111-4111-8111-111111111111",
            "kind": kind,
            "currency": "USD",
            "registeredAmount": amount,
            "occurredAt": "2020-01-01T00:00:00.000Z",
            "createdAt": "2020-01-01T00:00:00.000Z",
            "note": "Synthetic posted cash",
            "sourceTradeId": None,
            "actualFeeKnown": None,
            "receipt": {"kind": "cash", "requestId": "11111111-1111-4111-8111-111111111111"},
            "affectsOwnerCash": True,
        }

    return {
        "accountId": ACCOUNT["id"],
        "accountKind": "real",
        "revision": 7,
        "total": 2,
        "items": [
            entry("withdrawal", "external_withdrawal", "-30"),
            entry("deposit", "external_deposit", "100"),
        ],
    }


def test_cash_entries_original_node_field_mapping_preserves_registered_events_without_fake_running_points():
    page = cash_history_page()
    current = history_dto(
        page, "synthetic", ACCOUNT["id"], "USD", instance="isolated-instance", limit=50, offset=0
    )
    source_items = []
    for row in page["items"]:
        amount = Decimal(row["registeredAmount"])
        source_items.append(
            {
                "id": row["id"],
                "operationId": row["requestId"],
                "brokerAccountId": ACCOUNT["id"],
                "currency": "USD",
                "kind": row["kind"],
                "amount": int(amount.copy_abs()),
                "direction": -1 if amount < 0 else 1,
                "occurredAt": row["occurredAt"],
                "createdAt": row["createdAt"],
                "note": row["note"],
                "sourceOrderId": None,
                "balanceAfter": None,
            }
        )
    payload = {
        "mode": "entries",
        "owner": "synthetic",
        "account": {"id": ACCOUNT["id"]},
        "cashRows": [],
        "ledgers": {"USD": {"revision": "f" * 64, "balancesComplete": False, "items": source_items}},
        "currency": "USD",
        "limit": 50,
        "offset": 0,
    }
    run = subprocess.run(
        ["node", str(Path(__file__).with_name("broker_cash_read_source.cjs"))],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    original = json.loads(run.stdout)
    assert current.pop("accountKind") == "real"
    assert current.pop("coverageScope") == "platform_registered_entries_only"
    assert current.pop("historicalCoverageKnown") is False
    assert len(current.pop("snapshotRevision")) == 64
    original.pop("snapshotRevision")
    for item in current["items"]:
        assert item.pop("amountAuthority") == "registered_posting"
        assert item.pop("registeredAmount") in ("-30", "100")
        assert item.pop("receipt")["kind"] == "cash"
        assert item.pop("affectsOwnerCash") is True
        assert item["balanceAfter"] is None
    assert current == original


def test_cash_entries_query_and_scope_epoch_guard_unknown_fees_precision_and_foreign_currency():
    assert history_query(QueryParams("currency=USD")) == ("USD", 50, 0, None)
    for text, status in [
        ("currency=USD&currency=HKD", 400),
        ("currency=USD&limit=201", 400),
        ("currency=USD&offset=1", 409),
        ("currency=USD&snapshotRevision=bad", 400),
        ("currency=USD&offset=9007199254740992", 400),
        ("currency=USD&unknown=1", 400),
        ("currency=CHF", 400),
    ]:
        with pytest.raises(HTTPException) as error:
            history_query(QueryParams(text))
        assert error.value.status_code == status

    page = cash_history_page()
    baseline = history_dto(
        page, "synthetic", ACCOUNT["id"], "USD", instance="isolated-instance", limit=50, offset=0
    )
    old = subprocess.run(
        ["node", str(Path(__file__).with_name("broker_cash_read_source.cjs"))],
        input=json.dumps(
            {
                "mode": "entries",
                "owner": "synthetic",
                "account": {"id": ACCOUNT["id"]},
                "ledgers": {"USD": {"revision": "f" * 64, "balancesComplete": False, "items": []}},
                "currency": "USD",
                "limit": 50,
                "offset": 0,
                "expected": "0" * 64,
            }
        ),
        capture_output=True,
        text=True,
        check=True,
    )
    original_error = json.loads(old.stdout)
    for changed in ({**page, "revision": 8}, {**page, "accountKind": "simulated"}):
        with pytest.raises(HTTPException) as error:
            history_dto(
                changed,
                "synthetic",
                ACCOUNT["id"],
                "USD",
                instance="isolated-instance",
                limit=50,
                offset=0,
                expected=baseline["snapshotRevision"],
            )
        assert error.value.status_code == 409
        assert {"status": 409, "body": error_body(error.value)} == original_error
    for field, value, status in [
        ("actualFeeKnown", False, 409),
        ("registeredAmount", "0.123456789123456789", 409),
        ("currency", "HKD", 503),
    ]:
        changed = copy.deepcopy(page)
        changed["items"][0][field] = value
        if field == "actualFeeKnown":
            changed["items"][0]["sourceTradeId"] = "synthetic-unconfirmed-trade"
        with pytest.raises(HTTPException) as error:
            history_dto(
                changed, "synthetic", ACCOUNT["id"], "USD", instance="isolated-instance", limit=50, offset=0
            )
        assert error.value.status_code == status


@pytest.mark.parametrize("race", [False, True])
async def test_legacy_200_entry_page_uses_bounded_domain_reads_and_never_returns_a_partial_racing_snapshot(
    monkeypatch, race
):
    import alcor_api.cash_history as domain
    import alcor_api.legacy_cash_read as adapter

    sql = []

    class Connection:
        async def execute(self, query, args=None):
            sql.append(query)
            assert query.startswith("SELECT ")
            self.value = (
                {"revision": 7}
                if "cash_ledger_collections" in query
                else {"instance_id": "isolated-instance"}
            )
            return self

        async def fetchone(self):
            return self.value

        @asynccontextmanager
        async def transaction(self):
            yield self

    connection = Connection()

    class Database:
        @asynccontextmanager
        async def connection(self):
            yield connection

    db = Database()
    who = SimpleNamespace(id="synthetic")

    async def locked(conn, identity):
        assert conn is connection and identity is who

    monkeypatch.setattr(adapter, "source_read_lock", locked)
    page = cash_history_page()
    calls = []

    async def read(actual_db, identity, identifier, *, currency, limit, offset, revision):
        assert actual_db is db and identity is who and identifier == ACCOUNT["id"] and currency == "USD"
        assert limit <= 100 and revision == 7
        calls.append((limit, offset))
        if race and len(calls) == 2:
            raise HTTPException(409, "现金流水版本已变化，请重新读取第一页")
        return {
            **page,
            "total": 150,
            "items": [
                {**page["items"][0], "id": str(index)} for index in range(offset, min(offset + limit, 150))
            ],
        }

    monkeypatch.setattr(domain, "entries", read)
    if race:
        with pytest.raises(HTTPException) as error:
            await history_read(db, who, ACCOUNT["id"], QueryParams("currency=USD&limit=200"))
        assert error.value.status_code == 409
    else:
        result = await history_read(db, who, ACCOUNT["id"], QueryParams("currency=USD&limit=200"))
        assert len(result["items"]) == 150 and result["pagination"] == {
            "limit": 200,
            "offset": 0,
            "total": 150,
        }
        assert all(row["balanceAfter"] is None for row in result["items"])
    assert calls == [(100, 0), (100, 100)]
    assert len(sql) == 2
