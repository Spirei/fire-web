"""Synthetic owner HTTP integration; schedule separately from pure source vectors."""

from test_cash_ledger import account, command, submit
from test_legacy_devices import bearer, grant


async def counts(db, owner):
    async with db.connection() as conn:
        return [
            await (
                await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (owner,))
            ).fetchone()
            for table in (
                "cash_ledger_accounts",
                "cash_ledger_entries",
                "cash_ledger_collections",
                "cash_ledger_previews",
                "cash_ledger_operations",
            )
        ]


async def test_legacy_cash_owner_unknown_true_zero_original_opening_kind_and_read_no_writes(
    client, admin, db
):
    identifier = await account(client)
    pair = await grant(db, admin, "portfolio.read")
    before = await counts(db, admin)
    for version in (1, 2):
        response = await client.get(
            f"/api/v{version}/broker-accounts/{identifier}/cash", headers=bearer(pair)
        )
        assert response.status_code == 200, response.text
        assert response.headers["x-alcor-source-coverage"] == "platform-only"
        result = response.json()["data"]
        assert result["accountKind"] == "real" and result["historicalCoverageKnown"] is False
        assert all(
            row["balance"] is None
            and row["registeredBalance"] is None
            and row["opening"] is None
            and not row["complete"]
            and row["cashRevision"] == 0
            for row in result["currencies"]
        )
    assert await counts(db, admin) == before
    opening = command(identifier, amount="0")
    await submit(client, opening)
    response = await client.get(f"/api/v2/broker-accounts/{identifier}/cash", headers=bearer(pair))
    assert response.status_code == 200, response.text
    zero = next(r for r in response.json()["data"]["currencies"] if r["currency"] == "USD")
    assert (
        zero["balance"] == 0
        and zero["registeredBalance"] == 0
        and zero["complete"] is True
        and zero["opening"]["amount"] == 0
    )
    assert zero["activity"] == {
        "openingAmount": 0,
        "externalDeposits": 0,
        "externalWithdrawals": 0,
        "netExternalFlow": 0,
        "tradeNetFlow": 0,
        "entryCount": 1,
    }
    await submit(
        client,
        command(identifier, action="external_deposit", amount="100", occurredAt="2026-01-02T00:00:00Z"),
    )
    simulated = await account(client, "Synthetic cash simulator", account_kind="simulated")
    await submit(client, command(simulated, amount="999", accountKind="simulated"))
    before = await counts(db, admin)
    response = await client.get(f"/api/v1/broker-accounts/{identifier}/cash", headers=bearer(pair))
    assert response.status_code == 200, response.text
    rows = {r["currency"]: r for r in response.json()["data"]["currencies"]}
    assert rows["USD"]["balance"] == 100 and rows["USD"]["opening"]["amount"] == 0
    assert rows["USD"]["activity"]["externalDeposits"] == 100 and rows["USD"]["activity"]["entryCount"] == 2
    assert (
        rows["USD"]["available"] is None
        and rows["USD"]["reserved"] is None
        and rows["USD"]["withdrawalCapacity"]["amount"] is None
    )
    assert rows["HKD"]["balance"] is None
    simulation = await client.get(f"/api/v1/broker-accounts/{simulated}/cash", headers=bearer(pair))
    assert simulation.status_code == 200, simulation.text
    assert simulation.json()["data"]["accountKind"] == "simulated"
    assert (
        next(r for r in simulation.json()["data"]["currencies"] if r["currency"] == "USD")["balance"] == 999
    )
    path = f"/api/v2/broker-accounts/{identifier}/cash/entries"
    history = await client.get(path, params={"currency": "USD", "limit": 1}, headers=bearer(pair))
    assert history.status_code == 200, history.text
    history = history.json()["data"]
    assert history["accountKind"] == "real" and history["pagination"] == {"limit": 1, "offset": 0, "total": 2}
    assert history["items"][0]["amount"] == 100 and history["items"][0]["direction"] == 1
    assert history["items"][0]["balanceAfter"] is None and history["balancesComplete"] is False
    continued = await client.get(
        path,
        params={"currency": "USD", "limit": 1, "offset": 1, "snapshotRevision": history["snapshotRevision"]},
        headers=bearer(pair),
    )
    assert continued.status_code == 200, continued.text
    assert (
        continued.json()["data"]["items"][0]["kind"] == "opening"
        and continued.json()["data"]["items"][0]["amount"] == 0
    )
    assert (
        await client.get(path, params={"currency": "USD", "offset": 1}, headers=bearer(pair))
    ).status_code == 409
    stale = await client.get(
        path, params={"currency": "USD", "snapshotRevision": "0" * 64}, headers=bearer(pair)
    )
    assert stale.status_code == 409 and stale.json() == {
        "code": 40902,
        "message": "流水已变化，请从第一页重读",
    }
    assert await counts(db, admin) == before
    assert (await client.get(f"/api/v2/broker-accounts/{identifier}/cash")).status_code == 401
    denied = await grant(db, admin, "portfolio.read security.read")
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET scope='security.read' WHERE id=%s", (denied["grant_id"],)
        )
    assert (
        await client.get(f"/api/v2/broker-accounts/{identifier}/cash", headers=bearer(denied))
    ).status_code == 403
