"""Real bridge projection, synthetic rows only; no SDK/network/real database."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("futu_quotes", Path(__file__).parents[1] / "scripts/futu_quotes.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
project = module._detail_metrics
row = dict(equity_valid=True, turnover_rate=0.27, pe_ttm_ratio=39.36, pe_ratio=99,
           total_market_val=5070000000000, dividend_ratio_ttm=0.4)
assert project(row, "US") == dict(currency="USD", time="", source="futu", turnoverRate=0.27, peTtm=39.36, pe=99,
                                marketCap=5070000000000, dividendYieldTtm=0.4)
missing = project({"equity_valid": True, "pe_ratio": 99, "net_asset": 100, "trust_asset_value": 200}, "HK")
assert missing == dict(currency="HKD", time="", source="futu", turnoverRate=None, peTtm=None, pe=99, marketCap=None, dividendYieldTtm=None)
for valid in [False, None, "false", float("nan")]:
    result = project(dict(row, equity_valid=valid), "US")
    assert result["peTtm"] is result["pe"] is result["marketCap"] is result["dividendYieldTtm"] is None
    assert result["turnoverRate"] == 0.27
for bad in [None, "N/A", "", float("inf"), float("nan")]:
    result = project(dict(equity_valid=True, turnover_rate=bad, pe_ttm_ratio=bad, total_market_val=bad, dividend_ratio_ttm=bad), "CN")
    assert all(result[key] is None for key in ["turnoverRate", "peTtm", "marketCap", "dividendYieldTtm"])
result = project(dict(equity_valid=True, turnover_rate=0, pe_ttm_ratio=-12, total_market_val=0, dividend_ratio_ttm=0), "US")
assert result == dict(currency="USD", time="", source="futu", turnoverRate=0, peTtm=-12, pe=None, marketCap=None, dividendYieldTtm=0)
print("PASS strict snapshot metrics: eligibility, TTM isolation, actual zero, percentage points, negative PE, currency and no AUM fallback")
