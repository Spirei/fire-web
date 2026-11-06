import asyncio
import hashlib
import json
import subprocess
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from alcor_api import legacy_monthly_kline as module
from alcor_api.native_app_auth import CLIENT
from fastapi import FastAPI, HTTPException

HERE = Path(__file__).parent
FIXTURE = HERE.parent / "fixtures/monthly-kline-source"


def test_month_projection_uses_original_market_month_and_latest_immutable_revision():
    policy = SimpleNamespace(source="futu", source_version="futu-sdk-records-v1")
    def row(at, close, sequence):
        stamp = datetime.fromisoformat(at)
        return {"source_time": stamp, "sequence": sequence,
                "contents": {"at": at, "c": close, "source": "futu",
                             "sourceVersion": policy.source_version, "currency": "JPY", "session": "REGULAR"}}
    rows = [row("2026-01-31T15:00:00+00:00", "12", 1),
            row("2026-01-31T15:00:00+00:00", "13", 2),
            row("2026-01-01T00:00:00+09:00", "10", 3)]
    assert module.monthly_series(rows, policy, "JP") == {"months": ["2026-01", "2026-02"], "closes": [10, 13]}
    assert module.monthly_series([], policy, "JP") == {"months": [], "closes": []}
    rows[0]["contents"]["c"] = None
    with pytest.raises(HTTPException, match="月K原始事实"):
        module.monthly_series(rows, policy, "JP")


@pytest.mark.asyncio
async def test_original_three_routes_validation_and_response_shapes(monkeypatch):
    proof = json.loads((FIXTURE / "source.json").read_text())
    for file, digest in proof["fixtures_sha256"].items():
        assert hashlib.sha256((FIXTURE / file).read_bytes()).hexdigest() == digest
    series = {"months": [f"2025-{i:02}" for i in range(1, 13)] + ["2026-01"], "closes": list(range(1, 14))}
    cases = [{"version": version, "query": query, "series": series, **extra}
             for version in (None, 1, 2)
             for query, extra in [
                 ("market=US", {}), ("market=US&code=bad%20code", {}),
                 ("market=UNKNOWN&code=ABC", {}), ("market=US&code=ABC", {}),
                 ("market=US&code=ABC", {"upstreamError": True}),
                 ("market=US&code=ABC", {"throttled": True}),
                 ("market=US&code=" + "A" * 35, {}),
                 ("market=%EF%BB%BFus%EF%BB%BF&code=%EF%BB%BFabc%EF%BB%BF", {}),
             ]]
    expected = json.loads((await asyncio.to_thread(
        subprocess.run, ["node", str(HERE / "old_months.cjs")], input=json.dumps(cases),
        capture_output=True, text=True, check=True, timeout=15,
    )).stdout)
    app = FastAPI()
    who = SimpleNamespace(id="synthetic-owner")
    authority = SimpleNamespace(db=SimpleNamespace())
    async def native(*_args):
        return who, {"client_id": CLIENT}
    async def web(*_args, **_kwargs):
        return who, None
    monkeypatch.setattr(module, "native_identity", native)
    monkeypatch.setattr(module, "web_identity", web)
    monkeypatch.setattr(module, "identity", web)
    monkeypatch.setattr(module, "assert_native_origin", lambda *_args: None)
    module.mount_legacy_monthly_kline(app, SimpleNamespace(), authority)
    selected = {}
    async def limit(*_args, **_kwargs):
        return not selected.get("throttled")
    async def read(*_args, **_kwargs):
        if selected.get("upstreamError"):
            raise HTTPException(502, "K 线获取失败，请稍后重试")
        return series, {"sourceRevision": str(uuid4()), "adjust": "qfq"}
    app.state.rate_limit = limit
    app.state.monthly_history.read = read
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://example.invalid") as client:
        for case, wanted in zip(cases, expected, strict=True):
            selected.clear()
            selected.update(case)
            route = "/api/" + (f"v{case['version']}/" if case["version"] else "") + "kline"
            response = await client.get(route + "?" + case["query"], headers={"authorization": "Bearer fat_synthetic"})
            assert (response.status_code, response.json()) == (wanted["status"], wanted["body"]), case
            assert "no-store" in response.headers["cache-control"]
