"""Eastmoney US minute observations as timestamped prices."""
import json
from datetime import UTC, datetime
from decimal import Decimal
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .dividend_source_transport import fetch_page
from .fx_provider_parser import unique
from .market_contract import number

VERSION = 'eastmoney-us-minute-v1'
HOST = 'push2his.eastmoney.com'
PATH = '/api/qt/stock/trends2/get'
MARKETS = ('105', '106', '107')


def installed(query):
    return (query.market == 'US' and query.instrument == 'equity' and query.kind == 'price_series'
            and query.frame == 'minute' and query.adjust == 'none' and query.session in ('ALL', 'REGULAR'))


async def fetch(target, query, cursor):
    if (not installed(query) or cursor is not None or target.source != 'eastmoney' or target.host != HOST
            or target.scheme != 'https' or target.port != 443 or target.fixture):
        raise ValueError('eastmoney_minute_target_invalid')
    for market in MARKETS:
        secid = market + '.' + query.code
        params = urlencode({'secid': secid, 'ndays': 1, 'fields1': 'f1,f2,f3',
                            'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58'})
        approval = target.approval(secid)
        approval['target'] = ['https', HOST, 443, PATH]
        raw = await fetch_page('https://' + HOST + PATH + '?' + params, approval)
        body = json.loads(raw, object_pairs_hook=unique)
        if body.get('rc') == 0 and body.get('data') is None:
            continue
        data = body.get('data')
        if not isinstance(data, dict) or str(data.get('market')) != market or data.get('code') != query.code:
            raise ValueError('eastmoney_minute_security_mismatch')
        return raw, 'http_response_body'
    raise ValueError('eastmoney_minute_listing_unavailable')


def parse(raw, query):
    if not installed(query) or not isinstance(raw, bytes) or not 0 < len(raw) <= 131072:
        raise ValueError('eastmoney_minute_reply_invalid')
    body = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique)
    data = body.get('data') if isinstance(body, dict) and body.get('rc') == 0 else None
    if not isinstance(data, dict) or data.get('code') != query.code or str(data.get('market')) not in MARKETS:
        raise ValueError('eastmoney_minute_security_mismatch')
    rows = data.get('trends')
    if not isinstance(rows, list) or len(rows) > 1500:
        raise ValueError('eastmoney_minute_frame_invalid')
    facts, seen = [], set()
    for row in rows:
        fields = row.split(',')
        if len(fields) != 8:
            raise ValueError('eastmoney_minute_fields_invalid')
        local = datetime.strptime(fields[0], '%Y-%m-%d %H:%M').replace(tzinfo=ZoneInfo('Asia/Shanghai'))
        exchange = local.astimezone(ZoneInfo('America/New_York'))
        if local in seen:
            raise ValueError('eastmoney_minute_duplicate')
        seen.add(local)
        if not query.start <= exchange.date().isoformat() <= query.through:
            continue
        if query.session == 'REGULAR' and not '09:30' <= exchange.strftime('%H:%M') <= '16:00':
            continue
        facts.append({'at': local.astimezone(UTC).isoformat(), 'price': str(number(fields[2], positive=True)),
                      'source': 'eastmoney', 'sourceVersion': VERSION, 'currency': 'USD', 'session': query.session,
                      'marketTimezone': 'America/New_York', 'sourceSymbol': str(data['market']) + '.' + query.code,
                      'dataKind': 'provider_observed_minute_price', 'instrument': 'equity'})
    return facts, [], None
