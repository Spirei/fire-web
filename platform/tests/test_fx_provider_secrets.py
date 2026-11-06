import json
from decimal import localcontext
from uuid import uuid4

import pytest


@pytest.mark.parametrize(
    "precision,value",
    [
        ("epoch_seconds", "1700000000.0000000000000000000000000000000000001"),
        ("epoch_millis", "1700000000000.00000000000000000000000000000000001"),
        ("epoch_seconds", "1700000000.0000001"),
    ],
)
def test_sub_microsecond_never_rounds_into_valid_time(precision, value):
    from alcor_api.fx_provider_parser import source_time

    for digits in (6, 28, 80):
        with localcontext() as ctx:
            ctx.prec = digits
            with pytest.raises(ValueError, match="source_time_precision_unsupported"):
                source_time({"data": {"at": value}}, "data.at", precision)


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_path_query_key_and_bearer_are_vault_only_roundtrip(client, admin, app, db, caplog):
    approval = {
        "target": ["https", "provider.example", 443, "/path-secret-only/rates"],
        "addresses": ["192.0.2.20"],
    }
    object.__setattr__(db.settings, "fx_provider_targets", [approval])
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    actual = "https://provider.example/path-secret-only/rates?query-name-secret=value-secret&sig=%2b%2F"
    custom = {"url": actual, "approval": approval, "bearer": "bearer-secret-only", "declared_base": "USD"}
    saved = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
    )
    assert saved.status_code == 200, saved.text
    dto = await client.get("/api/reference/rates/provider")
    calls = []

    async def request(url, policy, headers):
        calls.append((url, policy, headers))
        return b'{"rates":{"HKD":7.8}}'

    service = app.state.reference_rates
    service.custom_requester = request
    rid = str(uuid4())
    await client.post("/api/reference/rates/refresh", json={"requestId": rid})
    assert await service.once() == "completed"
    snapshot = (await client.get("/api/reference/rates")).json()
    assert snapshot["identityCurrencies"] == ["USD"] and "USD" not in snapshot["quoted"]
    assert calls == [(actual, approval, {"Authorization": "Bearer bearer-secret-only"})]
    async with db.connection() as conn:
        config = await (
            await conn.execute("SELECT config,secret_cipher FROM fx_provider_revisions")
        ).fetchone()
        source = await (await conn.execute("SELECT source_uri FROM fx_observations")).fetchone()
        audits = await (await conn.execute("SELECT action,target_id FROM audit_events")).fetchall()
    public = json.dumps([config, source, audits]) + dto.text + saved.text + caplog.text
    for secret in ("path-secret-only", "query-name-secret", "value-secret", "bearer-secret-only"):
        assert secret not in public
    assert source["source_uri"] == "https://provider.example/[redacted]"
    assert "approval" not in config["config"] and "query_names" not in config["config"]


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [
        {"authorization": "secret"},
        {"headers": {"Authorization": "secret"}},
        {"password": "secret"},
        {"nested": {"token": "secret"}},
    ],
)
async def test_unknown_custom_fields_rejected_without_persistence(client, admin, db, extra):
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    custom = {
        "url": "https://provider.example/rates",
        "approval": {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
        "declared_base": "USD",
        **extra,
    }
    denied = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
    )
    assert denied.status_code == 400
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_provider_revisions")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT revision FROM fx_config")).fetchone())["revision"] == 1


@pytest.mark.parametrize(
    "value", ["2026-01-01T00:00:00.123456789Z", "2026-01-01T00:00:00.000000000000001+08:00"]
)
def test_instant_does_not_truncate_submicroseconds(value):
    from alcor_api.fx_provider_parser import source_time

    with pytest.raises(ValueError, match="source_time_precision_unsupported"):
        source_time({"at": value}, "at", "instant")


@pytest.mark.parametrize(
    "change",
    [
        {"bearer": {"token": "secret"}},
        {"declared_base": {"secret": "value"}},
        {"time_precision": {"secret": "value"}},
        {
            "approval": {
                "target": ["https", "provider.example", 443, "/rates"],
                "addresses": ["192.0.2.20"],
                "authorization": "secret",
            }
        },
        {"schedule": {"pattern": "09:00", "timezone": "UTC", "bearer": "secret"}},
    ],
)
def test_nested_or_non_scalar_fields_rejected(change):
    from alcor_api.fx_provider_credentials import separate

    config = {
        "url": "https://provider.example/rates",
        "approval": {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
        **change,
    }
    with pytest.raises(ValueError):
        separate(config)


@pytest.mark.parametrize("value", ["1e-9999999999", "1e9999999999", "0e-9999999999", "-1e9999999999"])
def test_extreme_exponents_fail_in_bounded_subprocess(value):
    import subprocess
    import sys
    from pathlib import Path

    module = Path(__file__).resolve().parents[1] / "backend/alcor_api/fx_provider_parser.py"
    script = "import importlib.util,sys;spec=importlib.util.spec_from_file_location('parser',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ntry: m.source_time({'at':sys.argv[2]},'at','epoch_seconds')\nexcept ValueError: sys.exit(0)\nelse: sys.exit(1)"
    result = subprocess.run(
        [sys.executable, "-c", script, str(module), value], capture_output=True, timeout=2, check=False
    )
    assert result.returncode == 0, result.stderr.decode()


@pytest.mark.parametrize("flag", ["false", "true", 0, 1, None, []])
def test_plaintext_permission_is_an_explicit_boolean(flag):
    from alcor_api.fx_provider_credentials import separate

    with pytest.raises(ValueError, match="approval_plaintext_invalid"):
        separate(
            {
                "url": "http://provider.example/rates",
                "approval": {
                    "target": ["http", "provider.example", 80, "/rates"],
                    "addresses": ["192.0.2.20"],
                    "allow_plaintext": flag,
                },
            }
        )
