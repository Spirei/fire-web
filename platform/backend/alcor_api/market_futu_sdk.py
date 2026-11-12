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
            result = {
                "qotLogined": logged if type(logged) is bool else None,
                "responded": ret == ret_ok,
                "quotePermissionVerified": False,
            }
            if logged is True and payload.get("quoteProbe") is True:
                try:
                    ret, frame = context.get_market_snapshot(["US.AAPL"])
                    rows = records(frame, limit=1) if ret == ret_ok else []
                    row = rows[0] if len(rows) == 1 else {}
                    price = row.get("last_price")
                    if row.get("code") == "US.AAPL" and type(price) in (int, float) and math.isfinite(price) and price > 0:
                        result.update(quotePermissionVerified=True, quote={"code": "US.AAPL", "price": price})
                except Exception:  # noqa: BLE001 -- SDK text may contain private target details.
                    pass
            return result
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
    realtime = []
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
            if ret == ret_ok and len(symbols)==1 and symbols[0].startswith('US.') and config['session'] in ('PRE','OVERNIGHT'):
                # Snapshot update_time is the regular close even while extended
                # fields change. Obtain an actual source minute clock instead.
                try:
                    subscribed_ret,_=context.subscribe(symbols,[enums['SubType'].RT_DATA],subscribe_push=False,is_first_push=False,session=getattr(enums['Session'],'ALL'))
                    subscribed=subscribed_ret==ret_ok
                    if subscribed:
                        rt_ret,rt_frame=context.get_rt_data(symbols[0])
                        if rt_ret==ret_ok:
                            observed=records(rt_frame,limit=6000)
                            realtime=next(([row] for row in reversed(observed) if row.get('is_blank') is False and type(row.get('cur_price')) in (int,float) and row['cur_price']>0),[])
                except Exception:
                    realtime=[]
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
            **({"realTimeRecords":realtime} if realtime else {}),
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
    streaming = sys.argv[1:] == ['--latest-stream']
    payload = None if streaming else json.load(sys.stdin)
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
        if streaming:
            # Import reuse only: every request gets its own quote context, its
            # actual response and the existing bounded scalar conversion.
            sys.__stdout__.write('{"ready":true,"protocol":"futu-read-v1"}\n')
            sys.__stdout__.flush()
            for _ in range(128):
                line = sys.stdin.buffer.readline(16386)
                if not line:
                    return
                if len(line) > 16385 or not line.endswith(b'\n'):
                    raise ValueError('sdk_request_too_large_or_incomplete')
                try:
                    request = json.loads(line)
                    if not isinstance(request,dict) or request.get('action') not in {'latest','futu.test','futu.quota'}:
                        raise ValueError('sdk_latest_stream_only')
                    request_started = time.perf_counter()
                    value = collect(OpenQuoteContext, RET_OK, request,
                                    {'AuType':AuType,'KLType':KLType,'Session':Session,'SubType':SubType})
                    if request.get('action') in {'futu.test','futu.quota'}:
                        value['sdkStartupMs'] = round((ready-startup)*1000)
                        value['connectionElapsedMs'] = round((time.perf_counter()-request_started)*1000)
                    output = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',',':'))
                except Exception:  # noqa: BLE001 -- Provider errors may contain private target details.
                    output = '{"error":"sdk_read_unavailable"}'
                # SDK logs remain on stderr, while only this protocol goes to
                # stdout; flush each complete independent observation.
                sys.__stdout__.write(output+'\n')
                sys.__stdout__.flush()
            return
        value = collect(
            OpenQuoteContext, RET_OK, payload, {"AuType": AuType, "KLType": KLType, "Session": Session, "SubType": SubType}
        )
    if payload.get("action") in {"futu.test", "futu.quota"}:
        value["sdkStartupMs"] = round((ready - startup) * 1000)
        value["connectionElapsedMs"] = round((time.perf_counter() - ready) * 1000)
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
