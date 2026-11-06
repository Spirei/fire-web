"""Administrator-only report originals, receipts, tombstones and rollback in isolated PG."""

import asyncio
import hashlib
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.financial_reports import metadata
from psycopg.errors import RaiseException
from test_account_admin import login

RAW = b"%PDF-1.7\nSynthetic report original; not actual financial observations.\n"
FIELDS = {
    "market": "us",
    "exchange": "nasdaq",
    "code": "demo",
    "companyName": "Synthetic company",
    "fiscalYear": "2026",
    "fiscalPeriod": "fy",
    "reportType": "Annual",
}


def test_original_typescript_metadata_golden_uses_no_real_files_or_accounts():
    fixture = Path(__file__).parent / "fixtures/financial-reports-source"
    manifest = json.loads((fixture / "source.json").read_text())
    assert hashlib.sha256((fixture / "library.ts").read_bytes()).hexdigest() == manifest["sha256"]
    result = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("financial_report_source.cjs")),
            str(fixture / "library.ts"),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    old = json.loads(result.stdout)
    normalized, _ = metadata(FIELDS, "Synthetic.pdf")
    for key, target in (
        ("market", "market"),
        ("exchange", "exchange"),
        ("code", "companyCode"),
        ("companyName", "companyName"),
        ("fiscalYear", "fiscalYear"),
        ("fiscalPeriod", "fiscalPeriod"),
        ("reportType", "reportType"),
        ("fileName", "fileName"),
        ("fileKind", "fileKind"),
        ("mimeType", "mimeType"),
    ):
        assert normalized[key] == old["report"][target]
    assert old["filter"]["values"] == ["US", "NASDAQ", "DEMO"]
    assert "ORDER BY fiscal_year DESC, fiscal_period DESC, created_at DESC" in old["filter"]["sql"]


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "report-files"


async def upload(client, revision=0, request=None, raw=RAW, legacy=False):
    data = dict(FIELDS)
    if not legacy:
        data.update({"requestId": str(request or uuid4()), "expectedRevision": str(revision)})
    return await client.post(
        "/api/v1/financial-reports" if legacy else "/api/financial-reports",
        data=data,
        files={"file": ("Synthetic.pdf", raw, "application/pdf")},
    )


async def test_upload_original_uuid_cas_and_admin_only_list(client, admin, app, settings, db):
    request = uuid4()
    saved = await upload(client, request=request)
    assert saved.status_code == 201, saved.text
    result = saved.json()
    assert result["sourceVerified"] is False
    report = result["report"]
    assert report["market"] == "US" and report["companyCode"] == "DEMO" and report["source"] == "manual"
    assert (await upload(client, request=request)).json() == result
    assert (await upload(client, request=request, raw=RAW + b"changed")).status_code == 409
    assert (await upload(client, request=uuid4())).status_code == 409
    assert (await client.get("/api/financial-reports/operations/" + str(request))).json() == result
    listing = (await client.get("/api/financial-reports?market=us")).json()
    assert listing["reports"] == [report] and listing["historicalCoverageKnown"] is False
    original = await client.get(report["fileUrl"])
    assert original.content == RAW and original.headers["x-content-type-options"] == "nosniff"
    assert "attachment;" in original.headers["content-disposition"]
    # The existing private-upload guard may reject this unmapped legacy path
    # before route lookup; neither outcome may publish the original.
    assert (await client.get("/uploads/reports/US/NASDAQ/DEMO/2026/FY/Synthetic.pdf")).status_code in (
        400,
        404,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anon:
        assert (await anon.get(report["fileUrl"])).status_code == 401
    await create_user(settings, "ReportPeer", "Synthetic9Pass", role="admin")
    peer = await login(app, "ReportPeer")
    try:
        assert (await peer.get("/api/financial-reports/operations/" + str(request))).status_code == 404
        assert (await peer.get(report["fileUrl"])).content == RAW
    finally:
        await peer.aclose()
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT * FROM financial_report_files")).fetchone()
        assert row["source_snapshot"]["sha256"] == result["sha256"]
        assert row["source_snapshot"]["sourceVerified"] is False
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM audit_events WHERE action='financial-report.uploaded'"
                )
            ).fetchone()
        )["n"] == 1


async def test_delete_is_tombstone_with_original_receipt_and_immutable_source(client, admin, db):
    original = (await upload(client)).json()
    report = original["report"]
    request = str(uuid4())
    url = f"/api/financial-reports/{report['id']}?requestId={request}&expectedRevision=1"
    removed = await client.delete(url)
    assert removed.status_code == 200, removed.text
    assert (await client.delete(url)).json() == removed.json()
    assert (await client.get("/api/financial-reports")).json()["reports"] == []
    assert (await client.get(report["fileUrl"])).status_code == 404
    assert (await client.get("/api/financial-reports/operations/" + original["requestId"])).json() == original
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT deleted_at,sha256 FROM financial_report_files")).fetchone()
        assert row["deleted_at"] is not None
        assert await (
            await conn.execute("SELECT 1 FROM admin_attachment_objects WHERE sha256=%s", (row["sha256"],))
        ).fetchone()
        with pytest.raises(RaiseException):
            async with conn.transaction():
                await conn.execute("UPDATE financial_report_files SET company_name='forged'")


async def test_audit_failure_rolls_back_objects_metadata_and_receipt_then_same_uuid_succeeds(
    client, admin, db
):
    request = uuid4()
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION report_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='financial-report.uploaded' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER report_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION report_audit_fail()",
            prepare=False,
        )
    failed = await upload(client, request=request)
    assert failed.status_code == 503, failed.text
    async with db.connection() as conn:
        for table in ("financial_report_files", "financial_report_operations", "admin_attachment_objects"):
            assert not await (await conn.execute("SELECT 1 FROM " + table)).fetchone()
        assert (await (await conn.execute("SELECT revision FROM financial_report_scope")).fetchone())[
            "revision"
        ] == 0
        await conn.execute(
            "DROP TRIGGER report_audit_fail ON audit_events; DROP FUNCTION report_audit_fail()", prepare=False
        )
    assert (await upload(client, request=request)).status_code == 201


async def test_close_and_upload_concurrency_cannot_create_after_closed_uuid(client, admin, db):
    request = str(uuid4())
    responses = await asyncio.gather(
        upload(client, request=request),
        client.post("/api/financial-reports/operations/" + request + "/close"),
    )
    assert responses[1].status_code == 200
    receipt = (await client.get("/api/financial-reports/operations/" + request)).json()
    if receipt["state"] == "closed":
        assert responses[0].status_code == 409
        assert (await upload(client, request=request)).status_code == 409
    else:
        assert responses[0].status_code == 201 and responses[1].json() == receipt


async def test_legacy_adapter_permissions_origin_and_filters(client, app, settings, db):
    assert (await client.get("/api/v1/financial-reports")).json() == {"code": 40101, "message": "未登录"}
    registered = await client.post(
        "/api/auth/register", json={"username": "LegacyReports", "password": "SyntheticReport9"}
    )
    assert registered.status_code == 201
    saved = await upload(client, legacy=True)
    assert saved.status_code == 200, saved.text
    report = saved.json()["data"]
    assert (await client.get("/api/v1/financial-reports?market=us&code=demo")).json() == {
        "code": 0,
        "message": "ok",
        "data": [report],
    }
    assert (await client.get(report["fileUrl"])).content == RAW
    assert (
        await client.post("/api/v1/financial-reports", headers={"origin": "https://other.invalid"})
    ).status_code == 401
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE username='LegacyReports'")
    assert (await client.get("/api/v1/financial-reports")).status_code == 403


async def test_late_demotion_after_upload_body_cannot_publish_original(client, admin, db, monkeypatch):
    import alcor_api.financial_report_api as module

    original = module.bounded_body

    async def demote(*args):
        raw = await original(*args)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
        return raw

    monkeypatch.setattr(module, "bounded_body", demote)
    result = await upload(client)
    assert result.status_code in (401, 403), result.text
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM financial_report_files")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM financial_report_operations")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM admin_attachment_objects")).fetchone()
