"""Exact legacy private-read projection baseline; private providers remain unported."""

import hashlib
import json
import subprocess
from pathlib import Path


def test_old_private_projection_allowlist_role_redaction_and_nested_secret_presence():
    root = Path(__file__).parents[1] / "fixtures/site-public-source"
    manifest = json.loads((root / "source-sha256.json").read_text())
    for file, expected in manifest.items():
        assert hashlib.sha256((root / file).read_bytes()).hexdigest() == expected
    secret = "SyntheticNeverPublish9"
    settings = {
        "domain": "https://public.example.invalid",
        "title": "Synthetic",
        "pgHost": "database.example.invalid",
        "pgPassword": secret,
        "smtpUser": "SyntheticSmtpUser",
        "smtpPassword": secret,
        "telegramBotToken": secret,
        "xueqiuCookie": secret,
        "quoteApiUrl": "https://operator:password@gateway.example.invalid/data?token=privileged",
        "usLogoApiUrl": "https://operator:password@images.example.invalid/logo?token=private&size=32",
        "unreviewedPrivateField": secret,
        "modelServicesInitialized": True,
        "modelServicesRevision": "a" * 64,
        "modelServices": [
            {
                "id": "synthetic",
                "apiKey": secret,
                "apiUrl": "https://model.example.invalid/v1",
                "models": ["synthetic"],
                "providerConfigs": {
                    "custom": {"apiKey": secret, "apiUrl": "https://other.example.invalid/v1"}
                },
            }
        ],
    }
    result = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("run_old_private_projection.cjs")),
            str(root),
        ],
        input=json.dumps({"settings": settings}),
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value["sourceProjection"] and value["providerAndDatabaseDisabled"] and value["sourceUnchanged"]
    admin, member = value["admin"], value["member"]
    assert secret not in result.stdout and "unreviewedPrivateField" not in admin
    assert admin["pgHost"] == settings["pgHost"] and member["pgHost"] == ""
    assert admin["smtpUser"] == settings["smtpUser"] and member["smtpUser"] == ""
    for name in ("pgPassword", "smtpPassword", "telegramBotToken", "xueqiuCookie"):
        assert admin[name] == member[name] == ""
        assert admin[name + "Configured"] is True and member[name + "Configured"] is False
    assert admin["quoteApiUrl"] == "https://gateway.example.invalid/data?token=privileged"
    assert member["quoteApiUrl"] == ""
    assert member["usLogoApiUrl"] == "https://images.example.invalid/logo?size=32"
    assert member["modelServices"] == [] and member["modelServicesInitialized"] is False
    model = admin["modelServices"][0]
    assert model["apiKey"] == "" and model["apiKeyConfigured"] is True
    assert model["providerConfigs"]["custom"]["apiKey"] == ""
    assert model["providerConfigs"]["custom"]["apiKeyConfigured"] is True


def test_private_write_mapping_exactly_covers_frozen_body_fields_without_claiming_execution():
    import re

    fixtures = Path(__file__).parents[1] / "fixtures"
    mapping = json.loads((fixtures / "site-settings-fields.json").read_text())
    source = (fixtures / "site-public-source/app/api/settings/route.ts").read_bytes()
    assert hashlib.sha256(source).hexdigest() == mapping["private_route_sha256"]
    fields = set(re.findall(r"\bbody\.([A-Za-z][A-Za-z0-9]*)", source.decode()))
    assert len(fields) == mapping["legacy_private_write"]["body_field_count"] == 121
    assert fields == set(mapping["legacy_private_write"]["body_fields"])
    assert mapping["legacy_private_write"]["status"] == "partial"
