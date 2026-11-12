"""One bounded, identity-checked Eastmoney quote; original decimals and source time."""

import json
from datetime import UTC, datetime
from decimal import Decimal
from urllib.parse import urlencode

from .dividend_source_transport import fetch_page
from .fx_provider_parser import unique
from .market_contract import CURRENCIES, ZONES, number
from .market_indices import provider_index

VERSION = 'eastmoney-quotes-v1'
HOSTS = ('push2delay.eastmoney.com', 'push2.eastmoney.com')
PATH = '/api/qt/ulist.np/get'


def symbol(query):
    if query.instrument == 'index':
        return provider_index(query.market, query.code, 'eastmoney')
    if query.instrument != 'equity' or not query.code.isascii() or not query.code.isdigit():
        raise ValueError('eastmoney_security_not_installed')
    if query.market == 'CN' and len(query.code) == 6:
        return ('1.' if query.code.startswith(('6', '9')) else '0.') + query.code
    if query.market == 'HK' and len(query.code) == 5:
        return '116.' + query.code
    raise ValueError('eastmoney_security_not_installed')


def installed(query):
    if (query.kind, query.frame, query.adjust, query.session) != ('latest', 'latest', 'none', 'REGULAR'):
        return False
    try:
        symbol(query)
        return True
    except ValueError:
        return False


async def fetch(target, query, cursor):
    if (not installed(query) or cursor is not None or target.source != 'eastmoney'
            or target.host not in HOSTS or target.scheme != 'https' or target.port != 443 or target.fixture):
        raise ValueError('eastmoney_fixed_target_required')
    secid = symbol(query)
    params = urlencode({'secids': secid, 'fltt': 2,
                        'fields': 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f20,f124'})
    approval = target.approval(secid)
    approval['target'] = ['https', target.host, 443, PATH]
    return await fetch_page('https://' + target.host + PATH + '?' + params, approval), 'http_response_body'


def parse(raw, query):
    if not installed(query) or not isinstance(raw, bytes) or not 0 < len(raw) <= 131072:
        raise ValueError('eastmoney_reply_invalid')
    payload = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non_finite')))
    data = payload.get('data') if isinstance(payload, dict) and payload.get('rc', 0) == 0 else None
    rows = data.get('diff') if isinstance(data, dict) else None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError('eastmoney_single_security_required')
    row = rows[0]
    market, security = symbol(query).split('.', 1)
    if str(row.get('f13')) != market or row.get('f12') != security:
        raise ValueError('eastmoney_security_mismatch')
    epoch = row.get('f124')
    if type(epoch) is not int or epoch <= 0:
        raise ValueError('eastmoney_source_time_required')
    fact = {'at': datetime.fromtimestamp(epoch, UTC).isoformat(), 'currency': CURRENCIES[query.market],
            'marketTimezone': ZONES[query.market], 'source': 'eastmoney', 'sourceVersion': VERSION,
            'sourceSymbol': symbol(query), 'price': str(number(row.get('f2'), positive=True)),
            'name': row.get('f14') if isinstance(row.get('f14'), str) else query.code,
            'instrument': query.instrument, 'indexValid': query.instrument == 'index',
            'session': 'REGULAR', 'requestedSession': 'REGULAR', 'cached': None,
            'providerCacheState': 'unknown', 'priceNumberAuthority': 'provider_fltt2_decimal',
            'sourceTimestampAuthority': 'provider_f124_epoch', 'priceBasis': 'provider_regular_market_quote'}
    for source, field in (('f3', 'changePct'), ('f4', 'change'), ('f5', 'volume'), ('f6', 'amount'),
                          ('f15', 'high'), ('f16', 'low'), ('f17', 'open'), ('f18', 'prevClose')):
        try:
            fact[field] = str(number(row[source], signed=field in ('change', 'changePct'),
                                     positive=field in ('high', 'low', 'open', 'prevClose')))
        except (KeyError, TypeError, ValueError):
            pass
    if query.instrument == 'equity':
        try:
            fact.update(marketCap=str(number(row['f20'], positive=True)),
                        marketCapCurrency=CURRENCIES[query.market], marketCapBasis='provider_f20')
        except (KeyError, TypeError, ValueError):
            pass
    return [fact], [], None
