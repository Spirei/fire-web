"""Actual old TS/iOS nullable contract vectors. No actual old runtime/server is started."""

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alcor_api.price_alert_contract import rule


def vectors():
    base = {
        "id": "10000000-0000-4000-8000-000000000001",
        "name": "Fixture",
        "code": "AAPL.OQ",
        "market": "US",
        "direction": "above",
        "price": "340.000001",
        "extended": True,
        "frequency": "once",
        "expiresAt": None,
    }
    cases = [
        ("ordinary", base),
        ("ios_nil_expiry_omitted", {k: v for k, v in base.items() if k != "expiresAt"}),
        ("hk_padded", {**base, "market": "HK", "code": "700"}),
        ("cn_padded", {**base, "market": "CN", "code": "1"}),
        ("preserved_us_suffix", {**base, "code": "AAPL.US"}),
        ("micros", {**base, "price": "0.000001"}),
        ("leading_zero", {**base, "price": "0001.5"}),
        ("sixteen_bit_name", {**base, "name": "🙂" * 40}),
        ("oversize_name", {**base, "name": "🙂" * 41}),
        ("float_price", {**base, "price": 340.1}),
        ("exponent_price", {**base, "price": "1e2"}),
        ("extra_decimal", {**base, "price": "1.0000001"}),
        ("zero", {**base, "price": "0"}),
        ("negative", {**base, "price": "-1"}),
        ("array_enum", {**base, "direction": ["above"]}),
        ("extra_field", {**base, "unreviewed": 1}),
        ("compact_uuid", {**base, "id": base["id"].replace("-", "")}),
        ("daily", {**base, "frequency": "daily"}),
    ]
    return [{"id": key, "raw": value} for key, value in cases]


def test_actual_legacy_rule_parser_and_ios_omitted_nil_contract(tmp_path):
    root = os.environ.get("ALCOR_ALERT_LEGACY_ROOT")
    if root is None:
        pytest.skip("Set the explicitly read-only old source root to execute real TS golden")
    here = Path(__file__).resolve().parent
    source = tmp_path / "alert-vectors.json"
    source.write_text(json.dumps(vectors(), ensure_ascii=False))
    response = subprocess.run(
        ["node", str(here / "run_alert_golden.cjs"), root, str(here / "source-evidence.json"), str(source)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert response.returncode == 0, response.stderr
    old = json.loads(response.stdout)
    for vector, expected in zip(vectors(), old, strict=True):
        try:
            actual = rule(vector["raw"], datetime(2026, 10, 20, 14, tzinfo=UTC))
            accepted = True
        except (ValueError, TypeError):
            actual, accepted = None, False
        assert accepted == expected["ok"], vector["id"]
        if accepted:
            assert actual == expected["rule"], vector["id"]
