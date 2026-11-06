"""Actual read-only SDK signatures with bounded controlled objects, never a real OpenD."""

import base64
from types import SimpleNamespace

import pytest
from alcor_api.market_futu_sdk import collect


class Frame:
    def to_dict(self, orient):
        assert orient == "records"
        return [{"code": "US.AAPL", "last_price": 340.1, "unknown_metric": float("nan")}]


class Context:
    def __init__(self, **kwargs):
        self.closed = False
        self.calls = []

    def get_market_snapshot(self, symbols):
        self.calls.append(("snapshot", symbols))
        return 0, Frame()

    def request_history_kline(self, symbol, **kwargs):
        self.calls.append(("history", symbol, kwargs))
        return 0, Frame(), b"next-page"

    def get_corporate_actions_dividends(self, symbol):
        self.calls.append(("announcement", symbol))
        return 0, {"dividend_list": []}

    def close(self):
        self.closed = True


ENUMS = {
    "KLType": SimpleNamespace(K_1M="source-minute", K_DAY="source-day"),
    "AuType": SimpleNamespace(NONE="source-none", QFQ="source-qfq"),
    "Session": SimpleNamespace(RTH="source-regular", ALL="source-all", OVERNIGHT="source-overnight"),
}


def test_one_shared_snapshot_batch_and_close_unknown_metric_not_zero():
    context = Context()
    result = collect(
        lambda **_: context,
        0,
        {"action": "latest", "host": "controlled", "port": 1234, "symbols": ["US.AAPL", "HK.00700"]},
        ENUMS,
    )
    assert context.calls == [("snapshot", ["US.AAPL", "HK.00700"])] and context.closed
    assert result["records"][0]["unknown_metric"] is None and result["nextCursor"] is None
    assert result["representation"] == "sdk_json_representation_not_wire_bytes"


def test_history_explicit_period_adjust_session_and_original_page_key():
    context = Context()
    result = collect(
        lambda **_: context,
        0,
        {
            "action": "history",
            "host": "controlled",
            "port": 1234,
            "symbols": ["US.AAPL"],
            "query": {
                "frame": "minute",
                "adjust": "none",
                "session": "ALL",
                "start": "2026-10-01",
                "through": "2026-10-31",
            },
            "cursor": base64.b64encode(b"previous-page").decode(),
        },
        ENUMS,
    )
    args = context.calls[0][2]
    assert args == {
        "start": "2026-10-01",
        "end": "2026-10-31",
        "ktype": "source-minute",
        "autype": "source-none",
        "session": "source-all",
        "max_count": 100,
        "page_req_key": b"previous-page",
    }
    assert context.closed and base64.b64decode(result["nextCursor"]) == b"next-page"


def test_announcement_delegates_to_the_frozen_collector_same_context_lifecycle():
    context = Context()
    assert collect(
        lambda **_: context,
        0,
        {"action": "dividends.announcement", "host": "controlled", "port": 1234, "symbol": "US.AAPL"},
        ENUMS,
    ) == {"dividend_list": []}
    assert context.calls == [("announcement", "US.AAPL")] and context.closed


@pytest.mark.parametrize("action", ["trade", "account", "login", "subscribe", "notifications"])
def test_no_account_trade_login_subscribe_or_notification_method(action):
    created = []
    with pytest.raises(ValueError, match="action_invalid"):
        collect(lambda **kwargs: created.append(kwargs), 0, {"action": action}, ENUMS)
    assert created == []
