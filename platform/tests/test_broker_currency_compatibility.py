"""Explicit CHF account-metadata extension, preserving the frozen old oracle.

The current App sources are read-only inputs for optional actual Swift decoding.
No installed App, production account, cash balance or financial mutation is used.
"""

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from test_broker_accounts import create
from test_legacy_devices import bearer, grant

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize("version", [1, 2])
async def test_chf_account_metadata_web_to_app_and_app_to_web_keep_original_receipts(client, admin, db, version):
    account = await create(client, name="Synthetic CHF account", currency="CHF", currencies=["CHF", "USD"])
    pair = await grant(db, admin, "portfolio.read portfolio.write")
    path = f"/api/v{version}/broker-accounts"
    response = await client.get(path, headers=bearer(pair))
    assert response.status_code == 200, response.text
    row = response.json()["data"]["items"][0]
    assert row["currency"] == "CHF" and row["currencies"] == ["USD", "CHF"]
    assert row["accountKind"] == "real" and row["holdingSource"] == "manual"
    change = {"requestId": str(uuid4()), "revision": row["revision"], "name": "App CHF name",
              "currency": "CHF", "currencies": ["CHF"],
              "recordCollectionRevision": row["currencyUsage"]["recordCollectionRevision"]}
    changed = await client.put(path + "/" + row["id"], headers=bearer(pair), json=change)
    assert changed.status_code == 200, changed.text
    original = (await client.get(path + "/operations/" + change["requestId"], headers=bearer(pair))).json()
    current = (await client.get("/api/broker-accounts/" + row["id"])).json()
    assert current["currency"] == "CHF" and current["currencies"] == ["CHF"]
    assert current["name"] == "App CHF name" and current["id"] == account["id"]
    later = {**change, "requestId": str(uuid4()), "revision": current["revision"],
             "name": "Later CHF name", "currency": "USD", "currencies": ["USD", "CHF"]}
    assert (await client.put(path + "/" + row["id"], headers=bearer(pair), json=later)).status_code == 200
    replay = await client.put(path + "/" + row["id"], headers=bearer(pair), json=change)
    assert replay.json() == changed.json()
    assert (await client.get(path + "/operations/" + change["requestId"], headers=bearer(pair))).json() == original
    assert original["data"]["data"]["currency"] == "CHF"
    native_create = {"requestId": str(uuid4()), "name": "Created as CHF in App",
                     "providerId": None, "currency": "CHF", "currencies": ["CHF"]}
    created = await client.post(path, headers=bearer(pair), json=native_create)
    assert created.status_code == 201, created.text
    native_row = created.json()["data"]["data"]
    canonical = (await client.get("/api/broker-accounts/" + native_row["id"])).json()
    assert canonical["currency"] == "CHF" and canonical["currencies"] == ["CHF"]
    assert canonical["account_kind"] == "unknown"  # Never infer real/simulated from a currency or name.
    assert (await client.post(path, headers=bearer(pair), json={**native_create, "requestId": str(uuid4()), "currency": "ZZZ", "currencies": ["ZZZ"]})).status_code == 400
    read_only = await grant(db, admin, "portfolio.read")
    assert (await client.post(path, headers=bearer(read_only), json={**native_create, "requestId": str(uuid4())})).status_code == 403
    async with db.connection() as conn:
        for table in ("cash_ledger_entries", "trade_ledger"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table + " WHERE owner_id=%s", (admin,))).fetchone())["n"] == 0


async def test_chf_delta_is_explicit_while_frozen_old_web_oracle_is_unchanged(client, admin, db):
    frozen = FIXTURES / "broker-read-source"
    evidence = json.loads((frozen / "source-evidence.json").read_text())
    for name, wanted in evidence["sha256"].items():
        assert hashlib.sha256((frozen / name).read_bytes()).hexdigest() == wanted
    account = await create(client, name="Synthetic extension", currency="CHF", currencies=["CHF"])
    steps = [{"owner": admin, "action": "list", "version": version} for version in (1, 2)]
    oracle_input = {"accounts": [{"id": account["id"], "owner": admin, "name": account["name"],
                     "providerId": account["provider_id"], "currency": "CHF", "currencies": ["CHF"],
                     "revision": 1, "holdingSource": "manual", "createdAt": "2020-01-01T00:00:00.000Z",
                     "updatedAt": "2020-01-02T00:00:00.000Z"}], "steps": steps}
    run = await asyncio.to_thread(subprocess.run, ["node", str(Path(__file__).with_name("broker_read_source.cjs"))],
                                  input=json.dumps(oracle_input), capture_output=True, text=True, check=True)
    old = json.loads(run.stdout)
    # This deliberate additive difference is not ignored in the unchanged golden comparison.
    assert [r["status"] for r in old] == [409, 409]
    assert [r["body"]["message"] for r in old] == ["账户币种配置损坏，请恢复有效配置"] * 2
    pair = await grant(db, admin, "portfolio.read")
    for version in (1, 2):
        response = await client.get(f"/api/v{version}/broker-accounts", headers=bearer(pair))
        assert response.status_code == 200, response.text
        row = response.json()["data"]["items"][0]
        assert row["id"] == account["id"] and row["currency"] == "CHF" and row["currencies"] == ["CHF"]


@pytest.fixture(scope="session")
def current_broker_currency_decoder(tmp_path_factory):
    configured = os.environ.get("ALCOR_SYNC_IOS_ROOT")
    if not configured or not shutil.which("swiftc"):
        pytest.skip("Explicit current read-only iOS source and Swift compiler required")
    source = Path(configured)
    evidence = json.loads((FIXTURES / "broker-currency-current-source.json").read_text())
    for path, wanted in evidence["source_sha256"].items():
        assert hashlib.sha256((source / path).read_bytes()).hexdigest() == wanted
    work = tmp_path_factory.mktemp("actual-broker-currency-decoder")
    extracted = []
    for index, (path, markers) in enumerate(evidence["extracts"].items()):
        raw = (source / path).read_text()
        start, end = raw.index(markers[0]), raw.index(markers[1])
        output = work / ("Current" + str(index) + ".swift")
        output.write_text("import Foundation\n" + raw[start:end])
        extracted.append(str(output))
    support = (FIXTURES / "broker-read-source" / "DecoderSupport.swift").read_text().split("@main struct Main")[0]
    harness = work / "Main.swift"
    harness.write_text(support + '''
@main struct Main {
    static func main() throws {
        let page = try JSONDecoder().decode(AlcorBrokerAccountsPage.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let version: AlcorAPIVersion = CommandLine.arguments.last == "1" ? .v1 : .v2
        guard PortfolioCurrency(rawValue: "CHF")?.flagCode == "CH" else { throw ApiError(code: 1, message: "CHF unsupported") }
        for account in page.items {
            try account.validate(version: version, origin: URL(string: "https://synthetic.invalid")!)
            guard PortfolioCurrency(rawValue: account.currency) != nil else { throw ApiError(code: 1, message: "Currency unsupported") }
        }
        let result: [String: Any] = ["owner": page.accountId, "ids": page.items.map(\\.id), "currencies": page.items.map(\\.currency), "revision": page.collectionRevision]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
    }
}
''')
    binary = work / "decode"
    subprocess.run(["swiftc", "-module-cache-path", str(work / "module-cache"), *extracted, str(harness), "-o", str(binary)],
                   capture_output=True, text=True, check=True, timeout=90)
    return binary


@pytest.mark.parametrize("version", [1, 2])
async def test_current_actual_swift_account_and_currency_sources_decode_chf_http(client, admin, db, version, current_broker_currency_decoder):
    account = await create(client, name="Actual decoder CHF", currency="CHF", currencies=["CHF", "USD"])
    pair = await grant(db, admin, "portfolio.read")
    response = await client.get(f"/api/v{version}/broker-accounts", headers=bearer(pair))
    assert response.status_code == 200, response.text
    run = await asyncio.to_thread(subprocess.run, [str(current_broker_currency_decoder), str(version)],
                                  input=json.dumps(response.json()["data"]), capture_output=True, text=True, check=True, timeout=30)
    assert json.loads(run.stdout) == {"owner": admin, "ids": [account["id"]], "currencies": ["CHF"], "revision": 1}
