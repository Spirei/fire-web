"""Bounded SDK child entry; import itself opens no provider connection."""

import contextlib
import json
import sys


def collect(context_factory, ret_ok, host, port, symbol):
    context = context_factory(host=host, port=port)
    try:
        result, data = context.get_corporate_actions_dividends(symbol)
        if result != ret_ok or not isinstance(data, dict) or not isinstance(data.get("dividend_list"), list):
            raise ValueError("futu_response_invalid")
        return {"dividend_list": data["dividend_list"]}
    finally:
        context.close()


def main():
    payload = json.load(sys.stdin)
    # SDK diagnostic output is never confused with the exact JSON representation.
    with contextlib.redirect_stdout(sys.stderr):
        import logging

        from futu import RET_OK, OpenQuoteContext
        from futu.common.ft_logger import logger
        logger.file_level = logger.console_level = logging.CRITICAL + 1
        for handler in tuple(logger.file_logger.handlers):
            handler.close()
            logger.file_logger.removeHandler(handler)

        if payload == {"preflight": True}:
            from importlib.metadata import version
            value = {"sdk": version("futu-api"), "connected": False, "methodAvailable": callable(OpenQuoteContext.get_corporate_actions_dividends)}
        else:
            value = collect(OpenQuoteContext, RET_OK, payload["host"], payload["port"], payload["symbol"])
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
