"""Actual Swift Decimal/Codable source oracle and PG plans; no financial postings."""

import asyncio
import base64
import hashlib
import json
import os
import subprocess
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest
from alcor_api.fee_plan_sources import original
from alcor_api.fee_plans import calculate_component, validate_rule
from alcor_api.native_app_auth import issue_grant
from request_telemetry_tables import business_table_hashes

HERE = Path(__file__).parent


@pytest.fixture(scope="session")
def golden(tmp_path_factory):
    source = os.environ.get("ALCOR_SYNC_IOS_ROOT")
    if not source:
        pytest.skip("Explicit read-only iOS source required")
    evidence = json.loads((HERE / "source-evidence.json").read_text())
    for name, wanted in evidence["ios_sha256"].items():
        assert hashlib.sha256((Path(source) / name).read_bytes()).hexdigest() == wanted
    work = tmp_path_factory.mktemp("fee-swift-golden")
    binary = work / "golden"
    subprocess.run(["swiftc", "-module-cache-path", str(work/"module-cache"), *[str(Path(source)/name) for name in evidence["runtime_golden"]], str(HERE/"Golden.swift"), "-o", str(binary)], check=True, capture_output=True, text=True)
    return binary


async def account(client, name, provider, currency, currencies):
    result = await client.post("/api/broker-accounts", json={"request_id":str(uuid4()),"name":name,"provider_id":provider,"account_kind":"real","currency":currency,"currencies":currencies})
    assert result.status_code == 201, result.text
    return result.json()["data"]["id"]


async def vectors(golden, client, second=False):
    longbridge = await account(client,"Synthetic multi market","longbridge","USD",["USD","HKD"])
    huatai = await account(client,"Synthetic CN","huatai","CNY",["CNY"])
    raw = await asyncio.to_thread(subprocess.check_output,[str(golden),longbridge,huatai]+(["second"] if second else []),text=True)
    return json.loads(raw,parse_float=Decimal)


def command(raw):
    value=original(raw)
    return {"requestId":str(uuid4()),"planId":str(value["id"]).lower(),"revision":value["revision"]-1,"accountId":value["accountID"],"providerId":value["providerID"],"market":value["market"],"effectiveFrom":value["effectiveFrom"],"effectiveThrough":value.get("effectiveThrough"),"components":{key:validate_rule(rule) for key,rule in value["overrides"].items()},"confirmed":True,"legacyOriginal":raw}


async def submit(client, data):
    preview=await client.post("/api/fees/plans/preview",json=data)
    assert preview.status_code==200,preview.text
    assert preview.json()["cashEffect"] is None and preview.json()["historicalRecalculation"] is False
    response=await client.post("/api/fees/plans/operations",json={"data":data,"preview":preview.json()["preview"]})
    assert response.status_code==200,response.text
    return preview.json(),response.json()


async def test_swift_US_HK_CN_source_bytes_roundtrip_through_existing_fee_plans(client,admin,db,golden):
    fixture=await vectors(golden,client)
    for raw in fixture["plans"]:
        data=command(raw)
        preview,result=await submit(client,data)
        replay=await client.post("/api/fees/plans/operations",json={"data":data,"preview":preview["preview"]})
        assert replay.json()==result
        assert (await client.get("/api/fees/plans/operations/"+data["requestId"])).json()==result
    async with db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE id=%s",(admin,))).fetchone()
        pair=await issue_grant(conn,user,"portfolio.read portfolio.write","Synthetic fee reader")
    fields=(await client.get("/api/v2/app-state?namespace=fees",headers={"authorization":"Bearer "+pair["access_token"]})).json()["data"]["fields"]
    for raw in fixture["plans"]:
        source=original(raw)
        assert fields["plan/"+source["id"]]=={"revision":1,"value":raw}
    async with db.connection() as conn:
        row=await (await conn.execute("SELECT components,market,legacy_original_base64,effective_through FROM fee_plan_revisions WHERE market='us'")).fetchone()
        assert row["components"]["platform"]["rate"]=="0.000000001234567890123456789"
        assert row["legacy_original_base64"]==fixture["plans"][0] and row["effective_through"] is None
        for table in ("cash_ledger_entries","trade_ledger","trade_fee_corrections"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM "+table)).fetchone())["n"]==0


async def test_actual_swift_rule_vectors_and_unknown_monthly_contract_guards(client,admin,golden):
    fixture=await vectors(golden,client)
    for vector in fixture["vectors"]:
        rule=vector["rule"]
        if vector["amount"] is None:
            with pytest.raises(ValueError,match="fee_rule_unknown|fee_monthly_history_required"):
                calculate_component(rule,vector["quantity"],vector["gross"],"buy")
        else:
            value=calculate_component(rule,vector["quantity"],vector["gross"],"buy",monthly_before=vector["before"],unit_kind="contracts" if rule["basis"]=="contract" else None)
            assert value==Decimal(vector["amount"]),vector["name"]
    contract=next(v for v in fixture["vectors"] if v["name"]=="contract")
    with pytest.raises(ValueError,match="fee_contract_unit_evidence_required"):
        calculate_component(contract["rule"],contract["quantity"],contract["gross"],"buy")


async def test_original_bytes_identity_and_preview_fingerprint_cannot_be_replaced(client,admin,golden):
    fixture=await vectors(golden,client);data=command(fixture["plans"][0])
    bad={**data,"market":"hk"}
    assert (await client.post("/api/fees/plans/preview",json=bad)).status_code==422
    preview=(await client.post("/api/fees/plans/preview",json=data)).json()
    decoded=base64.b64decode(data["legacyOriginal"])
    changed={**data,"legacyOriginal":base64.b64encode(b" "+decoded).decode()}
    rejected=await client.post("/api/fees/plans/operations",json={"data":changed,"preview":preview["preview"]})
    assert rejected.status_code==409


async def test_existing_unknown_market_not_projected_as_empty_fields(client,admin,db):
    from test_fee_plans import account as old_account
    from test_fee_plans import payload
    data=payload(await old_account(client));await submit(client,data)
    async with db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE id=%s",(admin,))).fetchone()
        pair=await issue_grant(conn,user,"portfolio.read","Synthetic reader")
    before={}
    async with db.connection() as conn,conn.transaction():before=await business_table_hashes(conn)
    response=await client.get("/api/v2/app-state?namespace=fees",headers={"authorization":"Bearer "+pair["access_token"]})
    assert response.status_code==409 and "未知" in response.json()["message"]
    async with db.connection() as conn,conn.transaction():assert await business_table_hashes(conn)==before
