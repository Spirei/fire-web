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


@pytest.mark.parametrize('named', [True, False])
def test_unsupported_otc_is_isolated_from_other_batch_securities(named):
    class Rows:
        def __init__(self, rows): self.rows = rows
        def to_dict(self, _): return self.rows

    class Mixed(Context):
        def get_market_snapshot(self, symbols):
            self.calls.append(('snapshot', list(symbols)))
            if 'US.SFTBY' in symbols:
                return -1, 'Unsupported US.SFTBY' if named else 'Unsupported market'
            return 0, Rows([{'code': symbol, 'last_price': 25.1} for symbol in symbols])

    context = Mixed()
    result = collect(lambda **_: context, 0, {
        'action': 'latest', 'host': 'controlled', 'port': 1234,
        'symbols': ['US.AAPL', 'US.SFTBY', 'US.MSFT'],
    }, ENUMS)
    assert {row['code'] for row in result['records']} == {'US.AAPL', 'US.MSFT'}
    assert result['skipped'] == ['US.SFTBY'] and context.closed
    assert len(context.calls) <= 7


def test_extended_batch_keeps_each_security_own_clock_and_closes_only_own_subscriptions():
    class Rows:
        def __init__(self, rows): self.rows = rows
        def to_dict(self, _): return self.rows

    class Extended(Context):
        def get_market_snapshot(self, symbols):
            return 0, Rows([{'code': symbol, 'last_price': 25.1} for symbol in symbols])
        def subscribe(self, symbols, types, **kwargs):
            self.calls.append(('subscribe', list(symbols), types, kwargs))
            return 0, None
        def get_rt_data(self, symbol):
            at = '2026-11-13 04:01:00' if symbol == 'US.AAPL' else '2026-11-13 04:02:00'
            return 0, Rows([{'code': symbol, 'time': at, 'is_blank': False, 'cur_price': 25.2}])
        def unsubscribe(self, symbols, types):
            self.calls.append(('unsubscribe', list(symbols), types))

    context = Extended()
    enums = {**ENUMS, 'SubType': SimpleNamespace(RT_DATA='source-rt')}
    result = collect(lambda **_: context, 0, {
        'action': 'latest', 'host': 'controlled', 'port': 1234,
        'symbols': ['US.AAPL', 'US.MSFT'],
        'query': {'frame': 'latest', 'adjust': 'none', 'session': 'PRE'},
    }, enums)
    assert [(row['code'], row['time']) for row in result['realTimeRecords']] == [
        ('US.AAPL', '2026-11-13 04:01:00'), ('US.MSFT', '2026-11-13 04:02:00')]
    assert context.calls[0][0:3] == ('subscribe', ['US.AAPL', 'US.MSFT'], ['source-rt'])
    assert context.calls[-1] == ('unsubscribe', ['US.AAPL', 'US.MSFT'], ['source-rt'])
    assert context.closed


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
