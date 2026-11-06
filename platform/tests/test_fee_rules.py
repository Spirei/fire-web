import json
from decimal import Decimal
from pathlib import Path

import pytest
from alcor_api.fee_rules import plan, reconstruct

VECTORS = json.loads(Path(__file__).with_name("historical-golden.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS)
def test_unchanged_legacy_rules_golden(vector):
    actual = reconstruct(**vector["input"])
    expected = vector["expected"]
    assert actual["reason"] == expected["reason"]
    assert (None if actual["fees"] is None else Decimal(actual["fees"])) == (
        None if expected["fees"] is None else Decimal(str(expected["fees"]))
    )
    assert len(actual["components"]) == len(expected["components"])
    for a, e in zip(actual["components"], expected["components"]):
        assert {k: v for k, v in a.items() if k not in ("rate", "amount")} == {
            k: v for k, v in e.items() if k not in ("rate", "amount")
        }
        assert Decimal(a["amount"]) == Decimal(str(e["amount"]))
        assert Decimal(str(a["rate"])) == Decimal(str(e["rate"]))


def test_missing_or_unconfirmed_plan_never_zero():
    for raw in [
        None,
        {},
        {"effectiveFrom": "2025-01-01", "effectiveThrough": "2026-10-20", "confirmed": False},
    ]:
        with pytest.raises(ValueError):
            plan(raw, "longbridge")
    with pytest.raises(ValueError):
        plan({"effectiveFrom": "2025-01-01", "effectiveThrough": "2026-10-20", "confirmed": True}, "huatai")
