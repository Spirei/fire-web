"""Fixed CoinGecko identities and actual aggregate quotes; no invented candle or volume."""

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode

from .dividend_source_transport import fetch_page
from .fx_provider_parser import unique
from .market_contract import number

VERSION = 'coingecko-latest-v1'
COINS = {row['code']:row['id'] for row in json.loads((Path(__file__).parent/'data/discovery-mainstream-crypto.json').read_text())}


def installed(query):
    return (query.kind=='latest' and query.market=='ASSET' and query.code in COINS
            and query.frame=='latest' and query.instrument=='asset'
            and query.adjust=='none' and query.session=='REGULAR')


async def fetch(target,query,cursor):
    if (not installed(query) or cursor is not None or target.source!='coingecko'
            or target.host.lower()!='api.coingecko.com' or target.scheme!='https' or target.port!=443
            or target.fixture):
        raise ValueError('crypto_quote_fixed_source_required')
    params = urlencode({'vs_currency':'usd','ids':COINS[query.code],'order':'market_cap_desc',
                        'per_page':1,'page':1,'sparkline':'false','precision':'full'})
    raw = await fetch_page('https://api.coingecko.com'+target.path(COINS[query.code])+'?'+params,
                           target.approval(COINS[query.code]))
    return raw,'http_response_body'


def parse(raw,query):
    if not installed(query) or not isinstance(raw,bytes) or not 1<=len(raw)<=131072:
        raise ValueError('crypto_quote_response_invalid')
    rows = json.loads(raw,parse_float=Decimal,object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
    if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict):
        raise ValueError('crypto_quote_identity_required')
    row = rows[0]
    if row.get('id')!=COINS[query.code] or not isinstance(row.get('symbol'),str) or row['symbol'].upper()!=query.code:
        raise ValueError('crypto_quote_identity_mismatch')
    if not isinstance(row.get('last_updated'),str):
        raise TypeError('crypto_quote_source_time_required')
    stamp = datetime.fromisoformat(row['last_updated'])
    if stamp.tzinfo is None:
        raise ValueError('crypto_quote_source_time_required')
    fact = {'at':stamp.astimezone(UTC).isoformat(),'source':'coingecko','sourceVersion':VERSION,
            'sourceSymbol':COINS[query.code],'currency':'USD','marketTimezone':'UTC','instrument':'asset',
            'price':str(number(row['current_price'],positive=True)),
            'name':row['name'] if isinstance(row.get('name'),str) else query.code,
            'session':'UNKNOWN','requestedSession':'REGULAR','cached':None,'providerCacheState':'unknown',
            'priceBasis':'provider_aggregated_spot_price','changeBasis':'provider_rolling_24_hours',
            'rangeBasis':'provider_rolling_24_hours','sourceTimestampAuthority':'provider_aggregate_last_updated_not_individual_trade',
            'priceNumberAuthority':'provider_json_decimal_text','equityValid':False,'fundValid':False}
    for source,field,signed,positive in [('market_cap','marketCap',False,True),
                                          ('price_change_24h','change',True,False),
                                          ('price_change_percentage_24h','changePct',True,False),
                                          ('high_24h','high',False,True),('low_24h','low',False,True),
                                          ('total_volume','amountRolling24h',False,False)]:
        if row.get(source) is not None:
            try:
                fact[field]=str(number(row[source],positive=positive,signed=signed))
            except (ValueError,TypeError):
                continue
    if 'amountRolling24h' in fact:
        fact['amountRolling24hCurrency']='USD'
    if 'high' in fact and 'low' in fact and number(fact['high'])<number(fact['low']):
        raise ValueError('crypto_quote_range_inconsistent')
    return [fact],[],None
