import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from alcor_api.request_observability import rollup
from alcor_api.request_observability_api import snapshot

ROOT = Path(__file__).resolve().parents[1] / "fixtures/observability-source"


def old(payload):
    for name, sha in json.loads((ROOT / "source-sha256.json").read_text()).items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == sha
    result = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("run_old_observability.cjs")),
            str(ROOT),
        ],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


async def test_frozen_old_types_logs_rollups_docs_and_native_same_vectors(client, admin, app, db):
    now = datetime.now(UTC)
    at = int(now.timestamp() * 1000)
    rows = [
        {
            "at": at - 1000,
            "path": "/api/records",
            "method": "GET",
            "source": "web",
            "status": 200,
            "duration": 12,
        },
        {
            "at": at - 900,
            "path": "/api/records",
            "method": "POST",
            "source": "ios",
            "status": 422,
            "duration": 28,
        },
        {
            "at": at - 800,
            "path": "/api/records",
            "method": "POST",
            "source": "app",
            "status": 499,
            "duration": 48,
        },
        {
            "at": at - 700,
            "path": "/api/accounts",
            "method": "GET",
            "source": "other",
            "status": 503,
            "duration": 64,
        },
    ]
    content = "# Synthetic published reference\n\n中文内容"
    expected = old(
        {
            "now": at,
            "rows": rows,
            "content": content,
            "paths": [
                "/api/records/opaque-secret?token=secret",
                "/api/request-logs/events",
                "/api/unmatched-secret",
            ],
        }
    )
    assert expected["memoryOnly"] and expected["builtInNodeOnly"]
    assert expected["parsedVersions"] == [1, 1, 2, None, None, None]
    assert expected["conflict"] is None
    assert expected["routes"] == ["/api/records/[id]", None, "/api/[unmatched]"]
    body = {"content": content, "expectedRevision": None, "requestId": "8e02e6d6-9aa3-4610-89ea-4ebf6b9c0eaa"}
    result = await client.post("/api/api-docs?version=2", json=body)
    assert result.status_code == 200, result.text
    saved = result.json()["data"]
    assert {k: saved[k] for k in ("saved", "version", "bytes", "revision")} == expected["saved"]
    assert (await client.get("/api/api-docs?version=2")).json()["data"] == expected["document"]
    # Feed exact same synthetic normalized metadata into native PG; no real history is fabricated.
    app.state.request_observations.queue.clear()
    async with db.connection() as conn, conn.transaction():
        await conn.execute("TRUNCATE request_observations,request_rollups RESTART IDENTITY")
        await conn.execute("UPDATE request_rollup_state SET revision=0,aggregate_revision=0,detail_floor=0")
        for row in rows:
            await conn.execute(
                "INSERT INTO request_observations(at,path,method,source,status,duration) VALUES(to_timestamp(%s/1000.0),%s,%s,%s,%s,%s)",
                tuple(row[k] for k in ("at", "path", "method", "source", "status", "duration")),
            )
        await conn.execute("UPDATE request_rollup_state SET revision=4")
    await rollup(db)
    async with db.connection() as conn:
        actual = await snapshot(conn, {}, now)
    for key in (
        "summary",
        "chart",
        "chartUnit",
        "endpoints",
        "pagination",
        "heatmap",
        "logs",
        "revision",
        "today",
    ):
        assert actual[key] == expected["snapshot"][key], key


def test_removed_3d_routes_remain_only_in_frozen_history_not_runtime_targets():
    from alcor_api.operational_request_templates import TEMPLATES
    from alcor_api.operational_source_data import metadata
    from alcor_api.source_snapshot import SourceMismatch
    import pytest

    # Original source is retained byte-for-byte as evidence, not supported routing.
    expected = old({"now": 0, "rows": [], "content": "", "paths": ["/api/showcase/models"]})
    assert expected["routes"] == ["/api/showcase/models"]
    assert not any(path.startswith("/api/showcase/") for path in TEMPLATES)
    assert not any(path.startswith("/api/assistant") for path in TEMPLATES)
    with pytest.raises(SourceMismatch):
        metadata({"path": "/api/showcase/models", "method": "GET", "source": "web",
                  "status": 200, "duration": 1, "at": 0}, "requests")
