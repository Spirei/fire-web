import copy
import json
from datetime import datetime
from uuid import uuid4

import pytest
from alcor_api.fx_provider_credentials import materialize, separate
from alcor_api.fx_provider_parser import source_time


def custom():
    return {
        "url": "https://provider.example/private-path-secret?secret-key-name=x%2By&sig=A%2Fb%3D&x=1&x=2&blank=&plus=+",
        "approval": {
            "target": ["https", "provider.example", 443, "/private-path-secret"],
            "addresses": ["192.0.2.20"],
        },
        "bearer": "synthetic-bearer-secret",
        "declared_base": "USD",
        "time_field": "data.meta.observed",
        "time_precision": "epoch_seconds",
    }


def test_sealed_url_exact_rawquery_and_bearer():
    value = custom()
    public, sealed = separate(value)
    for token in ("private-path-secret", "secret-key-name", "synthetic-bearer-secret", "A%2Fb"):
        assert token not in json.dumps(public)
    actual, headers = materialize(public, sealed)
    assert actual == value["url"]
    assert headers == {"Authorization": "Bearer synthetic-bearer-secret"}
    assert value == custom()


@pytest.mark.parametrize(
    "where,key",
    [("root", "authorization"), ("root", "api_key"), ("approval", "token"), ("schedule", "secret")],
)
def test_unknown_secret_fields_rejected(where, key):
    value = custom()
    value["schedule"] = {"pattern": "09:00", "timezone": "UTC"}
    target = value if where == "root" else value[where]
    target[key] = "synthetic-extra-secret"
    with pytest.raises(ValueError):
        separate(value)


@pytest.mark.parametrize(
    "precision,value",
    [
        ("epoch_seconds", "1700000000.0000000000000000000000000000000000001"),
        ("epoch_millis", "1700000000000.0000000000000000000000000000000001"),
        ("instant", "2026-01-01T00:00:00.123456789Z"),
    ],
)
def test_nested_source_precision_cannot_be_silently_lost(precision, value):
    with pytest.raises(ValueError):
        source_time({"data": {"meta": {"observed": value}}}, "data.meta.observed", precision)


def test_exact_microsecond_survives_nested_path():
    assert source_time(
        {"data": {"meta": {"observed": "1700000000.123456"}}}, "data.meta.observed", "epoch_seconds"
    ) == ("instant", "2023-11-14T22:13:20.123456+00:00")


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_real_http_secret_never_public_but_transport_receives_it(client, admin, app, db):
    value = custom()
    object.__setattr__(db.settings, "fx_provider_targets", [copy.deepcopy(value["approval"])])
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    result = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 3, "revision": 1, "custom": value},
    )
    assert result.status_code == 200, result.text
    config = await client.get("/api/reference/rates/provider")
    calls = []

    async def requester(url, approval, headers):
        calls.append((url, headers))
        return b'{"data":{"base":"USD","rates":{"HKD":"7.8"},"meta":{"observed":"1700000000.123456"}}}'

    app.state.reference_rates.custom_requester = requester
    rid = str(uuid4())
    assert (await client.post("/api/reference/rates/refresh", json={"requestId": rid})).status_code == 202
    assert await app.state.reference_rates.once() == "completed"
    assert calls == [(value["url"], {"Authorization": "Bearer synthetic-bearer-secret"})]
    receipt = await client.get("/api/reference/rates/operations/" + rid)
    quote = await client.get("/api/reference/rates?observationId=" + receipt.json()["observation_id"])
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT config::text FROM fx_provider_revisions")).fetchall()
        sources = await (await conn.execute("SELECT source_uri FROM fx_observations")).fetchall()
    public = config.text + receipt.text + quote.text + str(rows) + str(sources)
    for token in ("private-path-secret", "secret-key-name", "synthetic-bearer-secret", "A%2Fb"):
        assert token not in public
    assert datetime.fromisoformat(quote.json()["observationInstant"]) == datetime.fromisoformat(
        "2023-11-14T22:13:20.123456+00:00"
    )

    assert quote.json()["identityCurrencies"] == ["USD"]
    assert "USD" not in quote.json()["quoted"]
    assert quote.json()["rates"]["USD"] == "1"
