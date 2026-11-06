"""Fixed, explicitly approved earnings providers. No quote enrichment or synthetic events."""

import asyncio
import calendar
import json
import math
import os
import re
import stat
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from ipaddress import ip_address
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpcore

from .fx_provider_parser import approved_target, unique
from .fx_provider_transport import PinnedBackend, resolve

SOURCE_VERSION = 'earnings-calendar-v1'
PURPOSE = 'earnings.calendar'
LIMIT = 2 * 1024 * 1024
HOSTS = {'nasdaq': 'api.nasdaq.com', 'eastmoney': 'datacenter.eastmoney.com', 'xueqiu': 'stock.xueqiu.com'}
MARKETS = {'nasdaq': 'US', 'eastmoney': 'CN', 'xueqiu': 'HK'}
SESSIONS = {'pre_hour': 'time-pre-market', 'after_hour': 'time-after-hours',
            'intraday': 'time-not-supplied', 'released': 'time-released'}


def scope(market, month, page_key):
    if market not in ('US', 'CN', 'HK') or not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}', month):
        raise ValueError('earnings_scope')
    first = date.fromisoformat(month + '-01')
    last = date(first.year, first.month, calendar.monthrange(first.year, first.month)[1])
    if not isinstance(page_key, str):
        raise TypeError('earnings_page')
    if market == 'US':
        if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', page_key) or not first <= date.fromisoformat(page_key) <= last:
            raise ValueError('earnings_day')
    elif market == 'CN':
        if not re.fullmatch(r'[1-9][0-9]{0,3}', page_key) or int(page_key) > 1000:
            raise ValueError('earnings_page')
    elif page_key != 'month':
        raise ValueError('earnings_page')
    return first, last


@dataclass(frozen=True)
class Target:
    id: str
    source: str
    addresses: tuple[str, ...]
    approved_access: bool
    cookie_file: str | None = None
    user_agent: str = 'AlcorApi'

    def validate(self):
        if not isinstance(self.id, str) or not 1 <= len(self.id) <= 128 or self.source not in HOSTS or self.approved_access is not True:
            raise ValueError('earnings_target_not_approved')
        if not isinstance(self.addresses, (tuple, list)) or not 1 <= len(self.addresses) <= 32:
            raise ValueError('earnings_pins')
        for value in self.addresses:
            if not isinstance(value, str):
                raise TypeError('earnings_pins')
            addr = ip_address(value)
            if not addr.is_global or addr.is_multicast or addr.is_reserved:
                raise ValueError('earnings_pins')
        if not isinstance(self.user_agent, str) or not 1 <= len(self.user_agent) <= 256 or not self.user_agent.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in self.user_agent):
            raise ValueError('earnings_user_agent')
        if self.source == 'xueqiu':
            if not isinstance(self.cookie_file, str) or not os.path.isabs(self.cookie_file):
                raise ValueError('earnings_private_cookie_required')
        elif self.cookie_file is not None:
            raise ValueError('earnings_cookie_source')
        return self

    @property
    def fingerprint(self):
        self.validate()
        return sha256(json.dumps(asdict(self), sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def request(self, market, month, page_key):
        self.validate()
        first, last = scope(market, month, page_key)
        if MARKETS[self.source] != market:
            raise ValueError('earnings_provider_market')
        headers = {'User-Agent': self.user_agent, 'Accept': 'application/json', 'Accept-Encoding': 'identity'}
        if self.source == 'nasdaq':
            path = '/api/calendar/earnings'
            query = {'date': page_key}
            headers['Referer'] = 'https://www.nasdaq.com/'
        elif self.source == 'eastmoney':
            path = '/securities/api/data/v1/get'
            query = {'reportName': 'RPT_PUBLIC_BS_APPOIN', 'columns': 'ALL',
                     'sortColumns': 'FIRST_APPOINT_DATE,SECURITY_CODE', 'sortTypes': '1,1',
                     'pageSize': '500', 'pageNumber': page_key,
                     'filter': f"(FIRST_APPOINT_DATE>='{first.isoformat()}')(FIRST_APPOINT_DATE<='{last.isoformat()}')"}
            headers['Referer'] = 'https://data.eastmoney.com/bbsj/yysj.html'
        else:
            path = '/v5/stock/screener/earnings_calendar/hk/list.json'
            query = {'begin_date': first.isoformat(), 'end_date': last.isoformat(), 'extend': 'all'}
            headers.update({'Referer': 'https://xueqiu.com/snb/web/financial-report-calendar/home', 'Origin': 'https://xueqiu.com'})
            headers['Cookie'] = private_cookie(self.cookie_file)
        host = HOSTS[self.source]
        return ('https://' + host + path + '?' + urlencode(query),
                {'target': ('https', host, 443, path), 'addresses': list(self.addresses)}, headers)


def private_cookie(path):
    # Do not follow a substituted symlink or accept a group/world-readable secret.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or not 0 < info.st_size <= 16384:
            raise ValueError('earnings_private_cookie_permissions')
        value = os.read(fd, 16385)
    finally:
        os.close(fd)
    if len(value) > 16384:
        raise ValueError('earnings_private_cookie_budget')
    value = value.decode('ascii').strip()
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('earnings_private_cookie_invalid')
    return value


class PageFailure(ValueError):
    def __init__(self, raw, status, complete):
        super().__init__('earnings_http_or_page_budget')
        self.raw, self.status, self.complete = raw, status, complete


async def fetch(target, market, month, page_key):
    url, approval, headers = target.request(market, month, page_key)
    host = approval['target'][1]
    approved_target(url, approval, approval['addresses'])
    async with asyncio.timeout(20):
        pins = approved_target(url, approval, await resolve(host, 443))
        async with (
            httpcore.AsyncConnectionPool(network_backend=PinnedBackend(host, 443, pins[0]), retries=0, max_connections=1) as pool,
            pool.stream('GET', url, headers=headers, extensions={'timeout': {'connect': 5, 'read': 10, 'write': 5, 'pool': 5}}) as response,
        ):
            raw = bytearray()
            try:
                async for chunk in response.aiter_stream():
                    remaining = LIMIT - len(raw)
                    raw.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        raise PageFailure(bytes(raw), response.status, False)
            except (httpcore.NetworkError, httpcore.ProtocolError, httpcore.TimeoutException) as exc:
                raise PageFailure(bytes(raw), response.status, False) from exc
            if response.status != 200:
                raise PageFailure(bytes(raw), response.status, True)
            return bytes(raw)


def text(value):
    return value.strip() if isinstance(value, str) else ''


def number(value):
    if isinstance(value, bool) or value is None or not isinstance(value, (str, int, float)):
        return None
    if isinstance(value, str):
        value = value.strip().replace(',', '').replace('$', '')
        if not value or value in ('--', 'N/A', 'n/a'):
            return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, OverflowError):
        return None


def item(market, symbol, name, day, **fields):
    if not symbol or not name or len(symbol) > 64 or len(name) > 4096:
        raise ValueError('earnings_identity')
    date.fromisoformat(day)
    return {'symbol': symbol, 'name': name, 'nameZh': name if market != 'US' else '',
            'market': market, 'date': day, 'time': '', 'quarter': '', 'epsForecast': '',
            'ests': None, 'marketCap': None, 'price': None, 'changePct': None, **fields}


def parse(raw, market, month, page_key):
    first, last = scope(market, month, page_key)
    if not isinstance(raw, bytes) or not raw or len(raw) > LIMIT:
        raise ValueError('earnings_page_budget')
    body = json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
    if not isinstance(body, dict):
        raise TypeError('earnings_document')
    items, next_page, count = [], None, None
    if market == 'US':
        data = body.get('data')
        rows = data.get('rows') if isinstance(data, dict) else None
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError('earnings_nasdaq_rows')
        for row in rows:
            if not isinstance(row, dict):
                raise TypeError('earnings_row')
            items.append(item(market, text(row.get('symbol')), text(row.get('name')), page_key,
                time=text(row.get('time')) or 'time-unknown', quarter=text(row.get('fiscalQuarterEnding')),
                epsForecast=text(row.get('epsForecast')), ests=number(row.get('noOfEsts')), marketCap=number(row.get('marketCap'))))
        # Each explicit day is a separately admitted acquisition, not an inferred month.
    elif market == 'CN':
        result = body.get('result')
        rows = result.get('data') if isinstance(result, dict) else None
        if not isinstance(rows, list):
            if body.get('success') is False and body.get('code') == 9201:
                return {'items': [], 'nextPage': None, 'reportedPageCount': 0}
            raise ValueError('earnings_eastmoney_rows')
        if body.get('success') is False or len(rows) > 500:
            raise ValueError('earnings_eastmoney_status')
        pages = result.get('pages')
        if type(pages) is not int or not 0 <= pages <= 1000 or pages < int(page_key) and rows:
            raise ValueError('earnings_eastmoney_pages')
        count = pages
        if int(page_key) < pages:
            next_page = str(int(page_key) + 1)
        for row in rows:
            if not isinstance(row, dict):
                raise TypeError('earnings_row')
            symbol = text(row.get('SECURITY_CODE'))
            day = text(row.get('FIRST_APPOINT_DATE'))[:10]
            if not re.fullmatch(r'[0-9]{6}', symbol):
                raise ValueError('earnings_security')
            items.append(item(market, symbol, text(row.get('SECURITY_NAME_ABBR')), day,
                              quarter=text(row.get('REPORT_TYPE_NAME'))))
    else:
        if number(body.get('error_code')) != 0:
            raise ValueError('earnings_xueqiu_status')
        data = body.get('data')
        groups = data.get('items') if isinstance(data, dict) else None
        if not isinstance(groups, list) or len(groups) > 1000:
            raise ValueError('earnings_xueqiu_rows')
        for group in groups:
            if not isinstance(group, dict):
                raise TypeError('earnings_xueqiu_group')
            for bucket, session in SESSIONS.items():
                rows = group.get(bucket, [])
                if not isinstance(rows, list) or len(rows) > 10000:
                    raise ValueError('earnings_xueqiu_bucket')
                for row in rows:
                    if not isinstance(row, dict):
                        raise TypeError('earnings_row')
                    symbol, stamp = text(row.get('symbol')), number(row.get('report_date'))
                    if not re.fullmatch(r'[0-9]{1,5}', symbol) or stamp is None:
                        raise ValueError('earnings_xueqiu_identity')
                    day = datetime.fromtimestamp(stamp / 1000, UTC).astimezone(ZoneInfo('Asia/Hong_Kong')).date().isoformat()
                    year = row.get('fiscal_year')
                    fiscal = str(year) if type(year) is int else text(year)
                    items.append(item(market, symbol.zfill(5), text(row.get('name')), day, time=session,
                                      quarter=' '.join(value for value in (fiscal, text(row.get('report_type_name'))) if value)))
    for value in items:
        if not first <= date.fromisoformat(value['date']) <= last:
            raise ValueError('earnings_event_outside_requested_month')
    if len(items) > 20000:
        raise ValueError('earnings_items_budget')
    return {'items': items, 'nextPage': next_page, 'reportedPageCount': count}
