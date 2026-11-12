"""Tencent's original one-security minute prices, without synthesizing OHLC."""

import json
import re
from datetime import UTC, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from .dividend_source_transport import fetch_page
from .fx_provider_parser import unique
from .market_contract import CURRENCIES, ZONES, number
from .market_tencent_latest import symbol

VERSION = 'tencent-minute-v1'
HOST = 'web.ifzq.gtimg.cn'
PATH = '/appstock/app/minute/query'


def installed(query):
    return (query.market in ('CN', 'HK') and query.instrument == 'equity'
            and (query.kind, query.frame, query.adjust, query.session)
            == ('price_series', 'minute', 'none', 'REGULAR'))


async def fetch(target, query, cursor):
    if (not installed(query) or cursor is not None or target.source != 'tencent'
            or target.host != HOST or target.scheme != 'https' or target.port != 443 or target.fixture):
        raise ValueError('tencent_minute_fixed_target_required')
    code = symbol(query.market, query.code)
    return await fetch_page('https://' + HOST + PATH + '?code=' + code, target.approval(code)), 'http_response_body'


def parse(raw, query):
    if not installed(query) or not isinstance(raw, bytes) or not 0 < len(raw) <= 131072:
        raise ValueError('tencent_minute_reply_invalid')
    payload = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non_finite')))
    key = symbol(query.market, query.code)
    data = payload.get('data') if isinstance(payload, dict) and payload.get('code') == 0 else None
    if not isinstance(data, dict) or set(data) != {key} or not isinstance(data[key], dict):
        raise ValueError('tencent_minute_security_mismatch')
    observed = data[key].get('data')
    if not isinstance(observed, dict) or not re.fullmatch(r'[0-9]{8}', str(observed.get('date', ''))):
        raise ValueError('tencent_minute_date_unknown')
    date = datetime.strptime(observed['date'], '%Y%m%d').date()
    rows = observed.get('data')
    if not isinstance(rows, list) or len(rows) > 600:
        raise ValueError('tencent_minute_budget_exceeded')
    facts, issues, clocks, duplicate = [], [], set(), False
    for position, row in enumerate(rows):
        try:
            values = row.split() if isinstance(row, str) else []
            if len(values) not in (3, 4) or not re.fullmatch(r'[0-9]{4}', values[0]):
                raise ValueError('tencent_minute_row_invalid')
            clock = datetime.strptime(values[0], '%H%M').time()
            if clock in clocks:
                duplicate = True
                raise ValueError('tencent_minute_duplicate_clock')
            if not ('09:00' <= clock.strftime('%H:%M') <= '16:10'):
                raise ValueError('tencent_minute_clock_invalid')
            stamp = datetime.combine(date, clock, ZoneInfo(ZONES[query.market]))
            if query.start and date.isoformat() < query.start or query.through and date.isoformat() > query.through:
                raise ValueError('tencent_minute_outside_query')
            price = str(number(values[1], positive=True))
            clocks.add(clock)
            facts.append({'at': stamp.astimezone(UTC).isoformat(), 'price': price,
                          'currency': CURRENCIES[query.market], 'session': 'REGULAR',
                          'source': 'tencent', 'sourceVersion': VERSION, 'sourceSymbol': key,
                          'marketTimezone': ZONES[query.market], 'instrument': 'equity',
                          'dataKind': 'provider_observed_minute_price',
                          'priceNumberAuthority': 'provider_decimal_text',
                          'sourceTimestampAuthority': 'provider_date_and_minute'})
        except (ValueError, TypeError):
            issues.append({'position': position, 'reason': 'source_record_invalid_or_unknown'})
    # Duplicate minutes make the complete frame ambiguous; never keep one side.
    if duplicate:
        raise ValueError('tencent_minute_duplicate_clock')
    return facts, issues, None
