"""Legacy Web paging and SQLite LIKE semantics, without SQLite business storage."""

import math
import re

from .asset_lookup_contract import trim

ASCII_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def web_page_number(raw, fallback=1, maximum=None):
    text = trim(raw or "")
    try:
        if re.fullmatch(r"0[xX][a-fA-F0-9]+|0[bB][01]+|0[oO][0-7]+", text):
            try:
                number = float(int(text, 0))
            except OverflowError:
                number = math.inf
        elif re.fullmatch(r"[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)", text):
            number = float(text)
        else:
            number = 0 if not text else math.nan
    except (ValueError, OverflowError):
        number = math.nan
    if not number or math.isnan(number):
        number = fallback
    value = max(1, number if math.isinf(number) else math.floor(number))
    return min(maximum, value) if maximum is not None else value


def sqlite_like_contains(value, query):
    # SQLite LIKE folds ASCII only; '%' and '_' remain source wildcards.
    pattern = ("%" + trim(query) + "%").split("\0", 1)[0].translate(ASCII_UPPER)
    text = value.split("\0", 1)[0].translate(ASCII_UPPER)
    # A glob cursor avoids exponential regex backtracking on public queries.
    index = position = 0
    wildcard = -1
    restart = 0
    while position < len(text):
        if (
            index < len(pattern)
            and pattern[index] != "%"
            and (pattern[index] == "_" or pattern[index] == text[position])
        ):
            index += 1
            position += 1
        elif index < len(pattern) and pattern[index] == "%":
            wildcard = index
            index += 1
            restart = position
        elif wildcard >= 0:
            index = wildcard + 1
            restart += 1
            position = restart
        else:
            return False
    while index < len(pattern) and pattern[index] == "%":
        index += 1
    return index == len(pattern)
