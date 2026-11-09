"""Shared read-only SDK child protocol. No context is created by import."""

import base64
import contextlib
import json
import math
import sys
import time


def records(frame, limit=1000):
    values = frame.to_dict("records")
    if not isinstance(values, list) or len(values) > limit:
        raise ValueError("sdk_records_invalid")

    def convert(value):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        if isinstance(value, list):
            return [convert(item) for item in value]
        if isinstance(value, dict):
            return {key: convert(item) for key, item in value.items()}
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        raise ValueError("sdk_unrecognized_scalar")

    return convert(values)


def diagnostic_collect(factory, ret_ok, payload):
    action = payload["action"]
    context = factory(host=payload["host"], port=payload["port"])
    try:
        if action == "futu.test":
            ret, data = context.get_global_state()
            logged = data.get("qot_logined") if ret == ret_ok and isinstance(data, dict) else None
            return {
                "qotLogined": logged if type(logged) is bool else None,
                "responded": ret == ret_ok,
                "quotePermissionVerified": False,
            }
        subscription, historical = {}, {}
        try:
            ret, data = context.query_subscription(is_all_conn=False)
            if ret == ret_ok and isinstance(data, dict):
                subscription = {
                    key: data[key]
                    for key in ("total_used", "remain", "own_used")
                    if type(data.get(key)) is int and data[key] >= 0
                }
        except Exception:  # noqa: BLE001 -- No SDK error text or other connections' securities leave this child.
            subscription = {}
        try:
            ret, data = context.get_history_kl_quota(get_detail=False)
            if ret == ret_ok and isinstance(data, (tuple, list)) and len(data) >= 2:
                historical = {
                    key: value
                    for key, value in zip(("used_quota", "remain_quota"), data[:2], strict=True)
                    if type(value) is int and value >= 0
                }
        except Exception:  # noqa: BLE001 -- Missing counters remain unknown, never zero.
            historical = {}
        return {
            "subscription": subscription,
            "historyKl": historical,
            "subscriptionScope": "current_temporary_quote_connection",
            "detailsRequested": False,
        }
    finally:
        context.close()


def collect(factory, ret_ok, payload, enums):
    """One bounded quote read; only explicit price_series may subscribe its own symbol."""
    action = payload.get("action")
    if action in {"futu.test", "futu.quota"}:
        return diagnostic_collect(factory, ret_ok, payload)
    if action == "dividends.announcement":
        from alcor_api.dividend_futu_sdk import collect as announcements

        return announcements(factory, ret_ok, payload["host"], payload["port"], payload["symbol"])
    if action not in {"latest", "history", "price_series"}:
        raise ValueError("sdk_read_action_invalid")
    symbols = payload.get("symbols")
    if not isinstance(symbols, list) or not 1 <= len(symbols) <= 100 or len(set(symbols)) != len(symbols):
        raise ValueError("sdk_symbols_invalid")
    import re

    if any(
        not isinstance(symbol, str) or not re.fullmatch(r"(?:US|HK|SH|SZ|BJ)\.[A-Z0-9._-]{1,40}", symbol)
        for symbol in symbols
    ):
        raise ValueError("sdk_symbols_invalid")
    # Earlier latest-only callers had no query object; their snapshot remains regular.
    config = payload.get("query", {'frame':'latest','adjust':'none','session':'REGULAR'} if action=='latest' else {})
    if action == "history":
        from datetime import date

        if (
            len(symbols) != 1
            or config.get("frame") not in {"minute", "day", "week", "month", "quarter", "year"}
            or config.get("adjust") not in {"none", "qfq", "hfq"}
            or config.get("session") not in {"REGULAR", "ALL"}
        ):
            raise ValueError("sdk_history_semantics_invalid")
        begin, end = date.fromisoformat(config["start"]), date.fromisoformat(config["through"])
        if begin > end or (end - begin).days > 366 * 15:
            raise ValueError("sdk_history_window_invalid")
        if config["session"] != "REGULAR" and config["frame"] != "minute":
            raise ValueError("sdk_extended_only_minute")
    if action == "price_series" and (len(symbols)!=1 or config.get('frame')!='minute' or config.get('adjust')!='none' or config.get('session') not in ('REGULAR','ALL')):
        raise ValueError('sdk_price_series_semantics_invalid')
    if action == 'latest' and (config.get('frame') != 'latest' or config.get('adjust') != 'none'
            or config.get('session') not in ('REGULAR','PRE','AFTER','OVERNIGHT')
            or config.get('session') != 'REGULAR' and any(not symbol.startswith('US.') for symbol in symbols)):
        raise ValueError('sdk_latest_semantics_invalid')
    context = factory(host=payload["host"], port=payload["port"])
    subscribed = False
    try:
        if action == "price_series":
            arguments = {'subscribe_push': False, 'is_first_push': False}
            if symbols[0].startswith('US.'):
                arguments['session'] = getattr(enums['Session'], 'ALL' if config['session']=='ALL' else 'RTH')
            ret, _ = context.subscribe(symbols, [enums['SubType'].RT_DATA], **arguments)
            if ret != ret_ok:
                raise ValueError('sdk_own_subscription_rejected')
            subscribed = True
            ret, frame = context.get_rt_data(symbols[0])
            next_key = None
        elif action == "latest":
            ret, frame = context.get_market_snapshot(symbols)
            next_key = None
        else:
            cursor = payload.get("cursor")
            if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 87384):
                raise ValueError("sdk_cursor_invalid")
            key = base64.b64decode(cursor, validate=True) if cursor is not None else None
            if key is not None and not 1 <= len(key) <= 65536:
                raise ValueError("sdk_cursor_invalid")
            frames = {
                "minute": "K_1M",
                "day": "K_DAY",
                "week": "K_WEEK",
                "month": "K_MON",
                "quarter": "K_QUARTER",
                "year": "K_YEAR",
            }
            adjusts = {"none": "NONE", "qfq": "QFQ", "hfq": "HFQ"}
            sessions = {"REGULAR": "RTH", "ALL": "ALL"}
            arguments = {
                "start": config["start"],
                "end": config["through"],
                "ktype": getattr(enums["KLType"], frames[config["frame"]]),
                "autype": getattr(enums["AuType"], adjusts[config["adjust"]]),
                "max_count": 100,
                "page_req_key": key,
            }
            if config["frame"] == "minute" and symbols[0].startswith("US."):
                arguments["session"] = getattr(enums["Session"], sessions[config["session"]])
            else:
                # The provider's session parameter supports intraday bars only.
                arguments["extended_time"] = False
            ret, frame, next_key = context.request_history_kline(symbols[0], **arguments)
        if ret != ret_ok:
            raise ValueError("sdk_read_rejected")
        if next_key is not None and (not isinstance(next_key, bytes) or len(next_key) > 65536):
            raise ValueError("sdk_cursor_invalid")
        return {
            "records": records(frame, limit=6000 if action=='price_series' else 1000),
            "nextCursor": base64.b64encode(next_key).decode() if next_key is not None else None,
            "representation": "sdk_json_representation_not_wire_bytes",
            **({'subscriptionScope':'own_temporary_context_requested_symbol_only','subscriptionRelease':'unsubscribe_requested_and_context_closed_opend_retention_may_apply'} if action=='price_series' else {}),
        }
    finally:
        if subscribed:
            with contextlib.suppress(Exception):
                # Only this temporary context's requested symbol/type, never unsubscribe_all.
                context.unsubscribe(symbols, [enums['SubType'].RT_DATA])
        context.close()


def main():
    payload = json.load(sys.stdin)
    startup = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        import logging

        from futu import RET_OK, AuType, KLType, OpenQuoteContext, Session, SubType
        from futu.common.ft_logger import logger

        logger.file_level = logger.console_level = logging.CRITICAL + 1
        for handler in tuple(logger.file_logger.handlers):
            handler.close()
            logger.file_logger.removeHandler(handler)
        ready = time.perf_counter()
        value = collect(
            OpenQuoteContext, RET_OK, payload, {"AuType": AuType, "KLType": KLType, "Session": Session, "SubType": SubType}
        )
    if payload.get("action") in {"futu.test", "futu.quota"}:
        value["sdkStartupMs"] = round((ready - startup) * 1000)
        value["connectionElapsedMs"] = round((time.perf_counter() - ready) * 1000)
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
