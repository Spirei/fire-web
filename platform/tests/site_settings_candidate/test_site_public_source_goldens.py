"""Execute the frozen three public routes and real v2/origin policy without providers or DB."""

import hashlib
import json
import subprocess
from pathlib import Path


def run(commands, domain="https://public.example.invalid"):
    root = Path(__file__).parents[1] / "fixtures/site-public-source"
    manifest = json.loads((root / "source-sha256.json").read_text())
    for file, expected in manifest.items():
        assert hashlib.sha256((root / file).read_bytes()).hexdigest() == expected
    settings = {
        "title": "Synthetic public",
        "ico": "",
        "homepageBg": "",
        "loginSideImage": "",
        "domain": domain,
        "siteLogo": "",
        "logoText": "Synthetic",
        "logoFont": "system",
        "footerDesc": "",
        "homeNav": [],
        "allowRegister": True,
        "marketBadges": {},
        "marketBadgesVisible": True,
        "smtpPassword": "SyntheticPrivateSentinel",
        "pgPassword": "SyntheticPrivateSentinel",
        "llmApiKey": "SyntheticPrivateSentinel",
    }
    result = subprocess.run(
        ["node", "--experimental-vm-modules", str(Path(__file__).with_name("run_old_public.cjs")), str(root)],
        input=json.dumps({"settings": settings, "emailSupported": False, "commands": commands}),
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert (
        value["sourceRoutes"]
        and value["actualOriginFunction"]
        and value["realV2Policy"]
        and value["providerAndDatabaseDisabled"]
    )
    return value


def test_exact_old_public_projections_and_v2_explicit_credential_boundary():
    good = "Bearer fat_" + "A" * 43
    bad = "Bearer fat_" + "B" * 43
    value = run(
        [
            {"version": 0},
            {"version": 1, "headers": {"authorization": "invalid", "origin": "https://other.invalid"}},
            {"version": 2},
            {"version": 2, "headers": {"authorization": good}},
            {"version": 2, "headers": {"authorization": bad}},
            {"version": 2, "headers": {"authorization": "Bearer invalid"}},
            {"version": 2, "headers": {"origin": "https://other.invalid"}},
        ]
    )
    results = value["results"]
    assert [row["status"] for row in results] == [200, 200, 200, 200, 401, 401, 403]
    web = results[0]["body"]["settings"]
    v1 = results[1]["body"]["data"]
    assert len(web) == 14 and len(v1) == 10
    assert set(web) - set(v1) == {
        "loginSideImage",
        "emailRegistration",
        "marketBadges",
        "marketBadgesVisible",
    }
    assert "SyntheticPrivateSentinel" not in json.dumps(results)
    assert results[4]["body"]["code"] == 40102 and results[5]["body"]["code"] == 40101
    assert results[6]["body"]["code"] == 40301
    assert results[2]["headers"]["x-alcor-api-version"] == "2"
    assert value["authentications"] == 2


def test_exact_old_domain_projection_never_publishes_intranet_or_credentials():
    for domain in (
        "localhost:3000",
        "https://127.0.0.1",
        "https://operator:credential@public.example.invalid",
        "https://public.example.invalid/private",
        "https://public.example.invalid?token=private",
    ):
        result = run([{"version": 0}, {"version": 1}], domain)["results"]
        assert result[0]["body"]["settings"]["domain"] == result[1]["body"]["data"]["domain"] == ""
