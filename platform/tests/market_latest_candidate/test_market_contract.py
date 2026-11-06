"""Actual old normalizer and source contracts; no SDK context, network or portfolio reads."""

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alcor_api.market_contract import Query, futu_rows, public_items, source_time


def test_actual_old_six_market_normalization_and_public_aggregation(tmp_path):
    root = os.environ.get("ALCOR_MARKET_LEGACY_ROOT")
    if root is None:
        pytest.skip("Explicit read-only old source required for real TS golden")
    vectors = [
        [{"market": m, "code": c}]
        for m, c in [
            ("US", "AAPL.OQ"),
            ("US", "AAPL.US"),
            ("HK", "700"),
            ("CN", "1"),
            ("JP", "7203.T"),
            ("KR", "005930.KS"),
            ("ASSET", "BTC"),
            ("US", ""),
            ("HK", "0000"),
            ("US", "BAD/SECRET"),
            ("NO", "AAPL"),
        ]
    ]
    vectors.append(
        [
            {"market": "US", "code": "AAPL.N"},
            {"market": "US", "code": "AAPL"},
            {"market": "HK", "code": "700"},
        ]
    )
    here = Path(__file__).resolve().parent
    data = tmp_path / "vectors.json"
    data.write_text(json.dumps(vectors))
    result = subprocess.run(
        ["node", str(here / "run_market_golden.cjs"), root, str(here / "source-evidence.json"), str(data)],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    assert [public_items(items) for items in vectors] == json.loads(result.stdout)


@pytest.mark.parametrize("value", ["2026-03-08 02:30:00", "2026-11-01 01:30:00"])
def test_dst_gap_or_fold_without_source_offset_is_unknown(value):
    with pytest.raises(ValueError, match="ambiguous_or_nonexistent"):
        source_time(value, "America/New_York")


def test_real_source_offset_disambiguates_and_market_local_midnight_preserved():
    assert source_time("2026-11-01T01:30:00-04:00", "America/New_York") == datetime(
        2026, 11, 1, 5, 30, tzinfo=UTC
    )
    assert source_time("2026-10-20 00:00:00", "America/New_York") == datetime(2026, 10, 20, 4, tzinfo=UTC)


def test_actual_sdk_snapshot_fields_do_not_invent_extended_timestamp_or_session():
    facts, issues = futu_rows(
        {
            "records": [
                {
                    "code": "US.AAPL",
                    "name": "Fixture",
                    "update_time": "2026-10-20 10:00:00",
                    "last_price": "340.000001",
                    "prev_close_price": "330",
                    "pre_price": "350",
                    "volume": None,
                }
            ]
        },
        Query("latest", "US", "AAPL"),
    )
    assert not issues and len(facts) == 1
    assert facts[0]["price"] == "340.000001" and facts[0]["session"] == "UNKNOWN"
    assert facts[0]["at"] == "2026-10-20T14:00:00+00:00" and "volume" not in facts[0]
    assert "pre_price" not in facts[0]


def test_actual_ohlc_and_unknown_volume_remain_distinct_from_price_series():
    query = Query("bars", "US", "AAPL", "day", "qfq", start="2026-10-01", through="2026-10-31")
    rows = [
        {
            "code": "US.AAPL",
            "time_key": "2026-10-20 00:00:00",
            "open": "100",
            "high": "110",
            "low": "90",
            "close": "105",
        }
    ]
    facts, issues = futu_rows({"records": rows}, query)
    assert not issues and facts[0]["o"] == "100" and facts[0]["c"] == "105" and "v" not in facts[0]
    bad = [{**rows[0], "high": "80"}, {"code": "US.AAPL", "time_key": "2026-10-20 00:00:00", "close": "105"}]
    facts, issues = futu_rows({"records": bad}, query)
    assert facts == [] and len(issues) == 2


@pytest.mark.parametrize("changes", [{"adjust": "qfq"}, {"start": "2026-01-01"}, {"frame": "day"}])
def test_latest_cannot_be_relabelled_as_history(changes):
    with pytest.raises(ValueError):
        Query("latest", "US", "AAPL", **changes).validate()


def test_price_series_has_no_corporate_adjustment_or_synthetic_ohlc_contract():
    with pytest.raises(ValueError, match="price_series_has_no"):
        Query(
            "price_series",
            "ASSET",
            "BTC",
            "day",
            "qfq",
            instrument="asset",
            start="2026-01-01",
            through="2026-10-31",
        ).validate()
