import json
from fractions import Fraction
from pathlib import Path

import pytest
from alcor_api.fx_provider_parser import approved_target, parse, source_time

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "fx-legacy-golden.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["id"])
def test_legacy_vectors(vector):
    rejected = {
        "missing_base": "base_unknown",
        "non_usd_missing_bridge": "usd_bridge_missing",
        "root_error": "provider_error",
        "nested_error": "quotes_missing",
        "invalid_values": "quotes_missing",
        "hex_legacy": "quotes_missing",
        "normalized_collision": "currency_collision",
    }
    raw = json.dumps(vector["body"]).encode()
    if vector["id"] in rejected:
        with pytest.raises(ValueError, match=rejected[vector["id"]]):
            parse(raw)
    else:
        result = parse(raw)
        assert set(result["usd_ratios"]) == set(vector["usd"])
        for key, expected in vector["usd"].items():
            assert float(result["usd_ratios"][key]) == pytest.approx(expected)
        assert "MOP" not in result["usd_ratios"]


def test_exact_bridge_and_declared_base():
    result = parse(b'{"base":"EUR","rates":{"USD":1.2,"JPY":180}}')
    assert result["usd_ratios"]["EUR"] == Fraction(5, 6)
    assert result["usd_ratios"]["JPY"] == 150
    assert parse(b'{"rates":{"HKD":7.8}}', "USD")["usd_ratios"]["HKD"] == Fraction(39, 5)
    with pytest.raises(ValueError, match="base_conflict"):
        parse(b'{"base":"EUR","rates":{"USD":1.2}}', "USD")


@pytest.mark.parametrize(
    "raw", [b'{"base":"USD","rates":{"HKD":7,"HKD":8}}', b'{"base":"USD","rates":{"HKD":NaN}}']
)
def test_ambiguous_json(raw):
    with pytest.raises(ValueError):
        parse(raw)


def test_time_is_never_receipt_time():
    assert source_time({"received_at": "2026-11-01"}) == ("unknown", None)
    assert source_time({"date": "2026-10-30"}, "date", "date") == ("date", "2026-10-30")
    assert source_time({"time": "2026-10-30T12:01:02+08:00"}, "time", "instant")[0] == "instant"
    with pytest.raises(ValueError):
        source_time({"time": "2026-10-30T12:01:02"}, "time", "instant")


def test_explicit_private_http_target_and_rebinding():
    approval = {
        "target": ["http", "gateway.example", 8080, "/rates"],
        "addresses": ["10.0.0.7"],
        "allow_plaintext": True,
    }
    assert approved_target("http://gateway.example:8080/rates", approval, ["10.0.0.7"]) == ("10.0.0.7",)
    for url, addresses in [
        ("http://gateway.example:8080/rates", ["10.0.0.8"]),
        ("http://gateway.example:8081/rates", ["10.0.0.7"]),
        ("http://other.example:8080/rates", ["10.0.0.7"]),
    ]:
        with pytest.raises(ValueError):
            approved_target(url, approval, addresses)
