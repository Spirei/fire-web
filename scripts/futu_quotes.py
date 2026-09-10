#!/usr/bin/env python3
"""
富途 OpenAPI 行情桥接脚本（供 Next.js 服务端调用）。

通过本地 OpenD 网关（默认 127.0.0.1:11111）获取股票快照，输出 JSON：
  { "ok": true, "quotes": { "<id>": { ... } } }
或
  { "ok": false, "error": "..." }

用法：echo '<json>' | python3 scripts/futu_quotes.py
输入（行情）：{ "cmd": "quotes", "items": [ { "id": "...", "market": "US|HK|CN", "code": "AAPL|00700|600519",
                    "session": "PRE|AFTER|OVERNIGHT|REGULAR" } ] }
输入（搜索）：{ "cmd": "search", "keyword": "...", "limit": 8 }
session 由 Node 端按市场时段计算；US 盘前/盘后/夜盘分别取 Futu 快照里的
pre_price / after_price / overnight_price（含各自涨跌额），其余用 last_price。
"""

import json
import os
import sys
import re


def _ensure_utf8_io():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _num(value):
    """NaN / N/A / None → None，其余转 float"""
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None  # NaN → None


def _to_futu_code(market, code):
    raw = code.strip().upper()
    if market == "US":
        # 剥掉腾讯式交易所后缀（.OQ / .N / .AM 等），BRK.B 这类点号属于代码本身
        raw = re.sub(r"\.(OQ|N|AM|PS|K)$", "", raw)
        return "US." + raw
    if market == "HK":
        return "HK." + raw.lstrip("0").rjust(5, "0")
    if market == "CN":
        c = raw.rjust(6, "0")
        if c.startswith(("4", "8", "920")):
            return "BJ." + c
        if c.startswith(("6", "9")):
            return "SH." + c
        return "SZ." + c
    return ""


def _market_of_futu_symbol(symbol):
    prefix = symbol.split(".", 1)[0].upper()
    if prefix in ("SH", "SZ", "BJ"):
        return "CN"
    if prefix == "HK":
        return "HK"
    if prefix == "US":
        return "US"
    if prefix in ("JP", "KR", "SG"):
        return prefix
    return ""


def _to_app_symbol(market, code):
    raw = code.strip().upper()
    if market == "US":
        return "us" + re.sub(r"\.(OQ|N|AM|PS|K)$", "", raw)
    if market == "HK":
        return "hk" + raw.lstrip("0").rjust(5, "0")
    if market == "CN":
        if raw.startswith(("4", "8", "920")):
            return "bj" + raw
        if raw.startswith(("6", "9")):
            return "sh" + raw
        return "sz" + raw
    return ""


def _offending_symbols(error_text, symbols):
    """从富途报错文案里找出「不被支持的代码」，例如：
    「暂不提供美股 OTC 市场行情 SFTBY」→ ['US.SFTBY']。
    富途按整批返回错误，定位到具体代码后即可剔除重试，避免一只坏代码拖垮整批行情。"""
    text = str(error_text or "")
    if not text:
        return []
    hits = [s for s in symbols if s in text]
    if hits:
        return hits
    for symbol in symbols:
        bare = symbol.split(".", 1)[-1]
        # 裸代码按词边界匹配，避免 "N" / "V" 这类短代码误伤
        if len(bare) >= 2 and re.search(rf"(?<![A-Za-z0-9.]){re.escape(bare)}(?![A-Za-z0-9])", text):
            hits.append(symbol)
    return hits


def _market_snapshot(ctx, symbols, skipped, split_budget, ret_ok):
    """批量快照：整批失败时先剔除报错点名的代码重试，仍失败再二分定位。
    返回可用的 DataFrame 列表（可多段），不支持的代码记入 skipped。"""
    if not symbols:
        return []
    try:
        ret, data = ctx.get_market_snapshot(symbols)
    except Exception as exc:
        # 单次调用抛异常（网络抖动 / SDK 报错）也按「这批失败」处理，
        # 走下面的剔除与二分重试，不让整批行情陪葬。
        ret, data = -1, f"{type(exc).__name__}: {exc}"
    if ret == ret_ok:
        return [data]
    error = str(data)
    if len(symbols) == 1:
        skipped.append({"symbol": symbols[0], "error": error})
        return []
    offending = _offending_symbols(error, symbols)
    if offending:
        for symbol in offending:
            skipped.append({"symbol": symbol, "error": error})
        kept = [s for s in symbols if s not in offending]
        return _market_snapshot(ctx, kept, skipped, split_budget, ret_ok)
    if split_budget[0] <= 0:
        skipped.extend({"symbol": s, "error": error} for s in symbols)
        return []
    split_budget[0] -= 1
    mid = len(symbols) // 2
    return _market_snapshot(ctx, symbols[:mid], skipped, split_budget, ret_ok) + _market_snapshot(ctx, symbols[mid:], skipped, split_budget, ret_ok)


def main():
    _ensure_utf8_io()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"invalid input: {exc}"}))
        return

    cmd = payload.get("cmd") or "quotes"
    items = payload.get("items") or []
    if cmd != "search" and cmd != "quota" and not items:
        print(json.dumps({"ok": True, "quotes": {}}))
        return

    try:
        from futu import OpenQuoteContext, RET_OK
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"futu-api not installed: {exc}"}))
        return
    # 富途 SDK 的 FTConsoleLog 默认把日志打到 stdout，会污染本脚本的 JSON 输出，静默掉
    try:
        import logging
        console_logger = logging.getLogger("FTConsoleLog")
        console_logger.handlers = []
        console_logger.setLevel(logging.CRITICAL + 1)
    except Exception:
        pass

    host = str(payload.get("host") or os.getenv("FUTU_OPEND_HOST", "127.0.0.1"))
    port = int(payload.get("port") or os.getenv("FUTU_OPEND_PORT", "11111"))
    ctx = None
    try:
        ctx = OpenQuoteContext(host=host, port=port)

        if cmd == "quota":
            # 富途 OpenAPI 额度：实时订阅（query_subscription）+ 历史K线（get_history_kl_quota）
            quota = {}
            ret_sub, sub = ctx.query_subscription(is_all_conn=True)
            if ret_sub == RET_OK:
                total_used = int(sub.get("total_used") or 0)
                remain = int(sub.get("remain") or 0)
                own_used = int(sub.get("own_used") or 0)
                quota["subscription"] = {
                    "totalUsed": total_used,
                    "remain": remain,
                    "ownUsed": own_used,
                    "totalQuota": total_used + remain,
                    "ownTotalQuota": own_used + remain
                }
            else:
                quota["subscription"] = None
                quota["subscriptionError"] = str(sub)
            ret_kl, kl = ctx.get_history_kl_quota()
            if ret_kl == RET_OK:
                used_quota = int(kl[0] or 0)
                remain_quota = int(kl[1] or 0)
                quota["historyKl"] = {
                    "used": used_quota,
                    "remain": remain_quota,
                    "totalQuota": used_quota + remain_quota
                }
            else:
                quota["historyKl"] = None
                quota["historyKlError"] = str(kl)
            print(json.dumps({"ok": True, "quota": quota}, ensure_ascii=False))
            return

        if cmd == "search":
            keyword = str(payload.get("keyword") or "").strip()
            limit = int(payload.get("limit") or 8)
            if not keyword:
                print(json.dumps({"ok": True, "results": []}))
                return
            ret, data = ctx.get_search_quote(keyword, max_count=max(min(limit * 3, 30), 10))
            if ret != RET_OK:
                print(json.dumps({"ok": False, "error": str(data)}))
                return
            rows = []
            for _, row in data.iterrows():
                sec_type = str(row.get("sec_type") or "").upper()
                if sec_type not in ("STOCK", "ETF"):
                    continue
                symbol = str(row.get("code") or "")
                market = _market_of_futu_symbol(symbol)
                if market not in ("US", "HK", "CN"):
                    continue
                code_part = symbol.split(".", 1)[1] if "." in symbol else symbol
                app_symbol = _to_app_symbol(market, code_part)
                rows.append({
                    "symbol": app_symbol,
                    "code": code_part,
                    "name": str(row.get("name") or ""),
                    "market": market,
                    "futuSymbol": symbol
                })
            rows = rows[:limit]
            if rows:
                ret2, snap = ctx.get_market_snapshot([r["futuSymbol"] for r in rows])
                if ret2 == RET_OK:
                    snap_map = {str(r.get("code")): r for _, r in snap.iterrows()}
                    for r in rows:
                        row = snap_map.get(r["futuSymbol"])
                        if row is None:
                            continue
                        last = _num(row.get("last_price"))
                        prev = _num(row.get("prev_close_price"))
                        change_pct = _num(row.get("pre_change_rate"))
                        if change_pct is None and last and prev:
                            change_pct = (last - prev) / prev * 100
                        r["price"] = last
                        r["changePct"] = change_pct
            print(json.dumps({"ok": True, "results": rows}, ensure_ascii=False))
            return

        if cmd == "dividends":
            div_items = payload.get("items") or []
            if not div_items:
                print(json.dumps({"ok": True, "dividends": []}))
                return
            div_item = div_items[0]
            symbol = _to_futu_code(str(div_item.get("market") or ""), str(div_item.get("code") or ""))
            if not symbol:
                print(json.dumps({"ok": True, "dividends": []}))
                return
            ret, data = ctx.get_corporate_actions_dividends(symbol)
            if ret != RET_OK:
                print(json.dumps({"ok": False, "error": str(data)}))
                return
            dividend_list = data.get("dividend_list") if isinstance(data, dict) else []
            print(json.dumps({"ok": True, "dividends": dividend_list or []}, ensure_ascii=False))
            return

        if cmd == "kline":
            kl_items = payload.get("items") or []
            if not kl_items:
                print(json.dumps({"ok": True, "rows": []}))
                return
            kl_item = kl_items[0]
            symbol = _to_futu_code(str(kl_item.get("market") or ""), str(kl_item.get("code") or ""))
            if not symbol:
                print(json.dumps({"ok": True, "rows": []}))
                return
            ktype = str(payload.get("ktype") or "K_MON")
            start = str(payload.get("start") or "")
            end = str(payload.get("end") or "")
            max_count = int(payload.get("maxCount") or 100)
            autype = str(payload.get("autype") or "qfq")
            ret, data, _next = ctx.request_history_kline(
                symbol, start=start or None, end=end or None,
                ktype=ktype, autype=autype, max_count=max_count
            )
            if ret != RET_OK:
                print(json.dumps({"ok": False, "error": str(data)}))
                return
            rows = []
            for _, row in data.iterrows():
                rows.append({
                    "time_key": str(row.get("time_key") or ""),
                    "open": _num(row.get("open")),
                    "high": _num(row.get("high")),
                    "low": _num(row.get("low")),
                    "close": _num(row.get("close")),
                    "volume": _num(row.get("volume"))
                })
            print(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))
            return

        symbol_map = {}
        for item in items:
            market = str(item.get("market", "")).upper()
            code = str(item.get("code", ""))
            symbol = _to_futu_code(market, code)
            if symbol:
                symbol_map.setdefault(symbol, []).append(item)

        if not symbol_map:
            print(json.dumps({"ok": True, "quotes": {}}))
            return

        # 富途快照是「整批一起返回」：只要其中一只不被支持（如美股 OTC 的 SFTBY），
        # 整批都会失败 → 所有美股都拿不到行情，只能退回腾讯的常规盘口径
        # （当日盈亏冻结在上一交易日）。这里自动剔除报错点名的代码并二分重试，
        # 保证其余标的照常返回实时行情，不支持的代码由调用方继续走兜底源。
        skipped = []
        frames = _market_snapshot(ctx, list(symbol_map.keys()), skipped, [6], RET_OK)
        rows_data = [row for frame in frames for _, row in frame.iterrows()]

        out = {}
        for row in rows_data:
            symbol = str(row.get("code", ""))
            items_for_symbol = symbol_map.get(symbol)
            if not items_for_symbol:
                continue

            session = items_for_symbol[0].get("session", "REGULAR")
            last_price = _num(row.get("last_price"))
            prev_close = _num(row.get("prev_close_price"))

            price = last_price
            change = None
            change_pct = None
            eff_session = "REGULAR"
            if session == "PRE":
                pre_price = _num(row.get("pre_price"))
                if pre_price:
                    price = pre_price
                    change = _num(row.get("pre_change_val"))
                    change_pct = _num(row.get("pre_change_rate"))
                    eff_session = "PRE"
                    # 富途盘前向的 prev_close_price 会落后一个常规交易日（如周一盘前返回上周四收盘），
                    # 但 pre_change_val 是基于真正前一常规收盘（上周五）计算的。用 price - change
                    # 反推当日基准，保证「昨收 / 涨跌 / 当日盈亏」使用同一基准，否则详情页会显示
                    # 「现价 - 旧昨收」的错误涨跌。缺 change 时同样用反推基准，避免回退到错误的昨收。
                    if change is not None and price is not None:
                        prev_close = price - change
            elif session == "AFTER":
                after_price = _num(row.get("after_price"))
                if after_price:
                    price = after_price
                    # 实测 Futu 的 after_change_val 是「盘后价 - 常规收盘价」（接近 0），
                    # 不是「盘后价 - 昨收」，直接使用会导致盘后当日盈亏被重置为 0。
                    # 统一按 盘后价 - 昨收 计算当日涨跌；昨收缺失时才回退官方字段。
                    if prev_close and prev_close > 0:
                        change = price - prev_close
                        change_pct = change / prev_close * 100
                    else:
                        change = _num(row.get("after_change_val"))
                        change_pct = _num(row.get("after_change_rate"))
                    eff_session = "AFTER"
                    if change is not None and price is not None:
                        prev_close = price - change
            elif session == "OVERNIGHT":
                overnight_price = _num(row.get("overnight_price"))
                if overnight_price:
                    price = overnight_price
                    # 美东 20:00 为交易日分界：旧一天结算归档，夜盘属于新一天。
                    # 当日盈亏 = 夜盘波动（overnight_price - 今日常规收盘价），
                    # 即富途官方 overnight_change_val / overnight_change_rate，
                    # 与券商显示口径一致（夜盘只计小幅波动，不再显示昨天整天盈亏）。
                    change = _num(row.get("overnight_change_val"))
                    change_pct = _num(row.get("overnight_change_rate"))
                    if change is None and prev_close and prev_close > 0:
                        change = price - prev_close
                        change_pct = change / prev_close * 100
                    eff_session = "OVERNIGHT"
                    if change is not None and price is not None:
                        prev_close = price - change

            if price is None or price <= 0:
                continue
            if change is None and prev_close and prev_close > 0:
                change = price - prev_close
            if change_pct is None and prev_close and prev_close > 0:
                change_pct = change / prev_close * 100
            if change_pct is None:
                change_pct = 0

            for item in items_for_symbol:
                out[item["id"]] = {
                    "name": str(row.get("name") or "") or item.get("code", ""),
                    "price": price,
                    "change": change or 0,
                    "changePct": change_pct or 0,
                    "open": _num(row.get("open_price")) or price,
                    "high": _num(row.get("high_price")) or price,
                    "low": _num(row.get("low_price")) or price,
                    "time": str(row.get("update_time") or ""),
                    "prevClose": prev_close,
                    "session": eff_session,
                    "volume": _num(row.get("volume")),
                    "amount": _num(row.get("turnover")),
                    "turnover": _num(row.get("turnover_rate")),
                    "amplitude": _num(row.get("amplitude")),
                    "volumeRatio": _num(row.get("volume_ratio")),
                    "pe": _num(row.get("pe_ttm_ratio")) or _num(row.get("pe_ratio")),
                    "pb": _num(row.get("pb_ratio")),
                    "marketCap": _num(row.get("total_market_val")),
                    "circularMarketVal": _num(row.get("circular_market_val")),
                    "weekHigh": _num(row.get("highest52weeks_price")),
                    "weekLow": _num(row.get("lowest52weeks_price")),
                    "totalShares": _num(row.get("issued_shares")),
                    "floatShares": _num(row.get("outstanding_shares")),
                    "averagePrice": _num(row.get("avg_price")),
                    "dividendYieldTtm": _num(row.get("dividend_ratio_ttm")),
                    "secStatus": str(row.get("sec_status") or "")
                }
        print(json.dumps({"ok": True, "quotes": out, "skipped": skipped}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    finally:
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
