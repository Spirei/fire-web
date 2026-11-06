import asyncio
import json
import shutil
import subprocess
from uuid import uuid4

from alcor_api.config import ROOT
from fastapi import HTTPException
from personal_font_source_candidate.test_source_fonts import P, capture, consent, permission


async def test_actual_api_payloads_are_decoded_by_real_web_font_source_parser_and_503_is_original_receipt(
    client, admin, old_pg, source_file, app, settings, tmp_path
):
    from personal_font_catalog_candidate.test_catalog import C, catalog

    inventoried, _ = await catalog(client, old_pg)
    catalog_page = (await client.get(C + "/" + inventoried["catalogId"])).json()
    catalog_sources = (await client.get(P + "/catalog-sources")).json()
    p, registered = await permission(client, admin, old_pg, source_file)
    register_response = (await client.get(P + "/operations/" + registered["requestId"])).json()
    approved = await consent(client, p)
    consent_response = (await client.get(P + "/permissions")).json()
    cap, command = await capture(client, approved)
    captured_response = (await client.get(P + "/operations/" + command["requestId"])).json()
    available = (await client.get(P + "/registration-options")).json()
    registry = settings.font_import_registry_path
    settings.font_import_registry_path = None
    unconfigured = (await client.get(P + "/registration-options")).json()
    broken = tmp_path / "broken-font-registry"
    broken.write_text("not-json")
    settings.font_import_registry_path = broken
    unavailable = (await client.get(P + "/registration-options")).json()
    assert available["configuration"]["state"] == "configured"
    assert unconfigured["configuration"]["state"] == "not_configured"
    assert unavailable["configuration"]["state"] == "unavailable"
    # Config failure never revokes already-archived platform bytes or rights.
    assert (await client.get(cap["originalPath"])).content == source_file[2]
    proof = (await client.post(P + "/preview", json={"captureId": cap["id"]})).json()

    async def injected():
        raise HTTPException(503, "Synthetic post-write rollback")

    app.state.font_source_import.after_store = injected
    rid = str(uuid4())
    failed = await client.post(
        P + "/operations",
        json={
            "requestId": rid,
            "captureId": cap["id"],
            "permissionRevision": proof["plan"]["permissionRevision"],
            "expectedRevision": proof["plan"]["expectedRevision"],
            "preview": proof["preview"],
        },
    )
    assert failed.status_code == 503, failed.text
    recovered = await client.get(P + "/operations/" + rid)
    assert recovered.status_code == 200 and recovered.json() == failed.json()
    terminal = await client.post(P + "/operations/" + rid + "/close", json={"expectedKind": "apply"})
    assert terminal.json() == failed.json()
    absent = str(uuid4())
    assert (await client.get(P + "/operations/" + absent)).status_code == 404
    canceled = (
        await client.post(P + "/operations/" + absent + "/close", json={"expectedKind": "apply"})
    ).json()
    assert canceled["canceled"] and canceled["state"] == "failed"
    data = {
        "registered": register_response,
        "listing": consent_response,
        "captured": captured_response,
        "proof": proof,
        "available": available,
        "unconfigured": unconfigured,
        "unavailable": unavailable,
        "failed": failed.json(),
        "recovered": recovered.json(),
        "closed": terminal.json(),
        "canceled": canceled,
    }
    data.update(catalogPage=catalog_page, catalogSources=catalog_sources, catalogReceipt=inventoried)
    path = tmp_path / "real-api-responses.json"
    path.write_text(json.dumps(data))
    assert "Synthetic9Pass" not in path.read_text()
    script = r"""
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import {pathToFileURL} from 'node:url';
      const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const m=await import(pathToFileURL(process.argv[2]).href);
      m.fontSourceReceipt(d.registered,d.registered.requestId); m.fontSourceListing(d.listing);
      m.fontSourceReceipt(d.captured,d.captured.requestId); m.fontSourceProof(d.proof,d.captured.capture);
      for(const key of ['available','unconfigured','unavailable'])m.fontSourceOptions(d[key]);
      assert.equal(m.fontSourceAvailability(d.available),''); assert.match(m.fontSourceAvailability(d.unconfigured),/未配置/); assert.match(m.fontSourceAvailability(d.unavailable),/不可用/);
      for(const key of ['failed','recovered','closed','canceled'])assert.equal(m.fontSourceReceipt(d[key],d[key].requestId).state,'failed');
      const c=await import(pathToFileURL(process.argv[3]).href); c.fontCatalogSources(d.catalogSources); c.fontCatalogPage(d.catalogPage); c.fontCatalogReceipt(d.catalogReceipt,d.catalogReceipt.requestId);
      assert.deepEqual(d.failed,d.recovered); assert.deepEqual(d.failed,d.closed); assert.equal(d.canceled.canceled,true);
    """
    result = await asyncio.to_thread(
        subprocess.run,
        [
            shutil.which("node"),
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
            str(path),
            str(ROOT / "tests/fixtures/former-web-protocol/font-source-state.ts"),
            str(ROOT / "tests/fixtures/former-web-protocol/font-catalog-state.ts"),
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    settings.font_import_registry_path = registry
