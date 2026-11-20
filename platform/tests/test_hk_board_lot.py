from types import SimpleNamespace
from unittest.mock import AsyncMock
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from alcor_api import legacy_quote_api as api
from alcor_api.native_business_discovery import discovery


@pytest.fixture
def service(monkeypatch):
    app = FastAPI()
    monkeypatch.setattr(api, "assert_native_origin", lambda *_: None)
    monkeypatch.setattr(api, "native_identity", AsyncMock(return_value=(SimpleNamespace(id="owner"), {"client_id": api.CLIENT})))
    app.state.read_rate_limit = AsyncMock(return_value=True)
    api.mount_legacy_quote_reads(app, None, SimpleNamespace(db=None))
    observed = {"lotSize": 400, "source": "futu", "time": "2026-11-20T03:00:00+00:00", "displayStale": False}
    reader = AsyncMock(return_value={"quotes": {"00005": observed}})
    monkeypatch.setattr(app.state.batch_quote_reads, "read", reader)
    return TestClient(app, headers={"Authorization": "Bearer fat_test"}), reader, observed


@pytest.mark.parametrize("version", [1, 2])
def test_scoped_lot(service, version):
    client, reader, _ = service
    path = discovery(version)["hk_board_lot"]["path"]
    response = client.get(path, params={"code": "5"})
    assert response.status_code == 200
    assert response.json()["data"] == {"market": "HK", "code": "00005", "lotSize": 400, "source": "futu",
                                       "observedAt": "2026-11-20T03:00:00+00:00"}
    assert reader.await_args.args[1] == [{"id": "00005", "market": "HK", "code": "00005"}]


@pytest.mark.parametrize("query", ["code=0", "code=123456", "code=00005&code=00700", "code=AAPL", "market=US"])
def test_invalid_code(service, query):
    client, reader, _ = service
    assert client.get("/api/v2/hk-board-lot?" + query).status_code == 400
    reader.assert_not_awaited()


@pytest.mark.parametrize("fields", [{"lotSize": None}, {"lotSize": 0}, {"lotSize": 1.5}, {"lotSize": True},
                                     {"displayStale": True}, {"source": ""}])
def test_missing_evidence(service, fields):
    client, _, observed = service
    observed.update(fields)
    assert client.get("/api/v2/hk-board-lot?code=5").status_code == 503


def test_rejects_unauthorized(service, monkeypatch):
    client, reader, _ = service
    monkeypatch.setattr(api, "native_identity", AsyncMock(side_effect=HTTPException(403, "denied")))
    response = client.get("/api/v2/hk-board-lot?code=5")
    assert response.status_code == 403 and response.headers["X-Alcor-Retire-Context"] == "true"
    reader.assert_not_awaited()
