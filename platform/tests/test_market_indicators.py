"""Deferred shared arithmetic vectors against frozen original chart formulas."""

import json
import subprocess
from pathlib import Path

from alcor_api.market_indicators import calculate_indicators

FIXTURE = Path(__file__).parent / "fixtures/market-indicators/legacy.cjs"


def facts(values):
    return [
        {"factId": str(i), "at": f"observed-{i}", "c": None if value is None else str(value), "v": None}
        for i, value in enumerate(values)
    ]


def numeric(value):
    return None if value is None else float(value)


def test_old_ma_ema_boll_source_vectors_and_explicit_warmup():
    values = [10 + (i % 7) / 7 + i / 19 for i in range(80)]
    script = "const m=require(process.argv[1]);const v=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify({ma:m.movingAverage(v,20),ema:m.exponentialAverage(v,20),boll:m.bollinger(v,20)}));"
    result = subprocess.run(
        ["node", "-e", script, str(FIXTURE), json.dumps(values)], capture_output=True, text=True, check=True
    )
    original = json.loads(result.stdout)
    actual = calculate_indicators(facts(values))
    points = actual["points"]
    assert [numeric(point["ma"]["20"]) for point in points] == original["ma"]
    assert [numeric(point["ema20"]) for point in points] == [None] * 19 + original["ema"][19:]
    for field in ("mid", "upper", "lower"):
        assert [numeric(point["boll20"][field]) for point in points] == original["boll"][field]
    assert actual["calendarCompletenessVerified"] is False
    assert actual["newDefinitions"] == ["MACD", "RSI", "EMA_full_window_visibility"]


def test_unknown_close_resets_windows_without_zero_volume_or_calendar_insertion():
    original = facts([10] * 25 + [None] + [20] * 19)
    result = calculate_indicators(original)
    assert len(result["points"]) == len(original)
    assert all(point["volume"] is None and point["amount"] is None for point in result["points"])
    assert result["points"][24]["ema20"] == "10.0000"
    assert all(point["ema20"] is None for point in result["points"][25:])
    assert result["points"][25]["ma"]["5"] is None
    assert result["points"][-1]["observationsInSegment"] == 19
    assert [point["at"] for point in result["points"]] == [row["at"] for row in original]


def test_explicit_macd_rsi_definitions_and_full_window_insufficiency():
    flat = calculate_indicators(facts([10] * 40))["points"]
    assert all(point["rsi14"] is None for point in flat[:14])
    assert flat[14]["rsi14"] == "50.0000"
    assert all(point["macd"]["dif"] is None for point in flat[:25])
    assert all(point["macd"]["dea"] is None for point in flat[:33])
    assert flat[33]["macd"] == {"dif": "0.0000", "dea": "0.0000", "hist": "0.0000"}
    rising = calculate_indicators(facts(list(range(1, 41))))["points"]
    assert rising[14]["rsi14"] == "100.0000"
    assert rising[-1]["macd"]["dif"] is not None


def test_real_price_series_uses_price_field_without_manufacturing_ohlc_or_volume():
    original = [{'factId': str(i), 'at': f'observed-{i}', 'price': str(10+i), 'avgPrice': None,
                 'volume': None, 'dataKind': 'provider_real_time_time_frame'} for i in range(21)]
    derived = calculate_indicators(original, price_field='price')
    assert derived['inputField'] == 'price'
    assert derived['points'][19]['ma']['20'] == '19.5000'
    assert all(point['volume'] is None for point in derived['points'])
    assert all(not any(field in row for field in ('o', 'h', 'l', 'c', 'v')) for row in original)
    assert all(row['avgPrice'] is None for row in original)
    assert all(point['ema20'] is None for point in calculate_indicators(original)['points'])
