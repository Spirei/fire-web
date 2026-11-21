"""Exercise the bounded App projection through actual FastAPI/PG routes."""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from alcor_api.cli import create_user
from alcor_api.native_trading_cycle import BASIS, PATH, cycle_range
from test_legacy_trade_corrections import draft, native_headers
from test_trading import command, economic, setup, submit


def test_new_york_20_clock_handles_both_dst_transitions():
    def stamp(value):
        return datetime.fromisoformat(value)

    spring = cycle_range(stamp("2026-03-08T12:00:00Z"))
    assert spring == (stamp("2026-03-08T01:00:00Z"), stamp("2026-03-09T00:00:00Z"))
    fall = cycle_range(stamp("2026-11-01T12:00:00Z"))
    assert fall == (stamp("2026-11-01T00:00:00Z"), stamp("2026-11-02T01:00:00Z"))
    assert cycle_range(fall[1])[0] == fall[1]


async def test_cycle_excludes_old_fills_and_preserves_quantity_chain_for_frozen_display(client, admin, db, tmp_path):
    _, record = await setup(client)
    wall, _ = cycle_range(datetime.now(UTC))
    start, end = cycle_range(wall - timedelta(hours=1))
    fills = [
        (start - timedelta(seconds=1), "buy", "10", "10"),
        (start, "sell", "5", "11"),
        (start + timedelta(hours=2), "sell", "5", "12"),
        (end, "buy", "2", "10"),
    ]
    for when, side, quantity, price in fills:
        receipt, _ = await submit(client, command(record, side=side, quantity=quantity, price=price,
                                                   amount=str(int(quantity) * int(price)), occurredAt=when.isoformat()))
        record = receipt["record"]
    headers = await native_headers(db, admin)
    payload = (await client.get("/api/v2/auth/config")).json()["data"]
    assert payload["portfolio_trading_cycle"] == {
        "version": 1, "path": PATH, "read_scope": "portfolio.read", "basis": BASIS,
    }
    before = await economic(db, admin)
    response = await client.get(PATH, params={"cycleStart": start.isoformat(), "closes": "true"}, headers=headers)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["cache-control"]
    value = response.json()["data"]
    assert value["accountId"] == admin and value["basis"] == BASIS
    assert datetime.fromisoformat(value["cycleStart"]) == start and datetime.fromisoformat(value["cycleEnd"]) == end
    assert value["records"] == {record["id"]: record["revision"]}
    orders = sorted(value["items"], key=lambda row: row["tradedAt"])
    assert [(row["side"], row["positionQtyBefore"], row["positionQtyAfter"], row["amount"]) for row in orders] == [
        ("sell", 10, 5, 55), ("sell", 5, 0, 60), ("buy", 0, 2, 20),
    ]
    assert value["openingCloses"] == []
    (tmp_path / "native-trading-cycle.json").write_bytes(response.content)
    assert await economic(db, admin) == before
    current = await client.get(PATH, headers=headers)
    assert current.status_code == 200, current.text
    assert [row["id"] for row in current.json()["data"]["items"]] == [orders[-1]["id"]]
    assert (await client.get(PATH, params={"cycleStart": (start + timedelta(seconds=1)).isoformat()}, headers=headers)).status_code == 400
    assert (await client.get(PATH, params={"scope": "all"}, headers=headers)).status_code == 400
    peer = await create_user(db.settings, "TradingCyclePeer", "Synthetic9Pass", email="cycle-peer@example.invalid")
    peer_headers = await native_headers(db, peer)
    peer_read = await client.get(PATH, headers=peer_headers)
    assert peer_read.status_code == 200, peer_read.text
    assert peer_read.json()["data"]["accountId"] == peer
    assert peer_read.json()["data"]["records"] == {} and peer_read.json()["data"]["items"] == []
    assert (await client.get(PATH)).status_code == 401
    assert (await client.get(PATH, headers={**peer_headers, "x-alcor-expected-account": admin})).status_code == 403


async def test_cycle_uses_current_replacement_moved_across_boundary(client, admin, db):
    _, record = await setup(client)
    wall, _ = cycle_range(datetime.now(UTC))
    start, _ = cycle_range(wall - timedelta(hours=1))
    headers = await native_headers(db, admin)
    trading = "/api/v2/account-assets/trading"
    initial = (await client.get(trading, headers=headers)).json()["data"]
    original_time = (start - timedelta(seconds=1)).isoformat()
    entry = draft(admin, record, initial, tradedAt=original_time)
    preview = await client.post(trading + "/preview", headers=headers, json=entry)
    assert preview.status_code == 200, preview.text
    original = await client.post(trading + "/submissions", headers=headers, json={**entry, "requestId": str(uuid4())})
    assert original.status_code == 200, original.text
    state = (await client.get(trading, headers=headers)).json()["data"]
    order = state["orders"][0]
    body = {
        "requestId": str(uuid4()), "accountId": admin, "snapshotRevision": state["snapshotRevision"],
        "recordId": record["id"], "recordRevision": order["recordRevision"], "action": "amend",
        "orders": [{"id": order["id"], "revision": order["revision"]}],
        "replacement": {"qty": 5, "price": 13, "fees": 0, "tradedAt": (start + timedelta(hours=1)).isoformat()},
    }
    preview = await client.post(trading + "/corrections/preview", headers=headers, json=body)
    assert preview.status_code == 200, preview.text
    amended = await client.post(trading + "/corrections", headers=headers, json={
        **body, "previewRevision": preview.json()["data"]["previewRevision"],
    })
    assert amended.status_code == 200, amended.text
    cycle = await client.get(PATH, params={"cycleStart": start.isoformat()}, headers=headers)
    assert cycle.status_code == 200, cycle.text
    items = cycle.json()["data"]["items"]
    assert len(items) == 1 and items[0]["id"] != order["id"]
    assert (items[0]["qty"], items[0]["price"], items[0]["positionQtyBefore"], items[0]["positionQtyAfter"]) == (5, 13, 0, 5)
