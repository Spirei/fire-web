"""Licensed Chart V8 quotes and actual OHLC; explicit provider adjustment basis."""

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, localcontext
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .dividend_source_transport import fetch_page
from .fx_provider_parser import unique
from .market_contract import CURRENCIES, ZONES, number

VERSION = 'yahoo-chart-history-v1'
INDEXES = {
    'dji': ('US', 'DJI', '^DJI'), 'spx': ('US', 'SPX', '^GSPC'),
    'ndx': ('US', 'IXIC', '^IXIC'), 'hsi': ('HK', 'HSI', '^HSI'),
    'sse': ('CN', '000001', '000001.SS'), 'szse': ('CN', '399001', '399001.SZ'),
    'n225': ('JP', 'N225', '^N225'), 'ks11': ('KR', 'KS11', '^KS11'),
    'sti': ('SG', 'STI', '^STI'),
}
CRYPTOS = {
    'BTC': 'BTC-USD', 'ETH': 'ETH-USD', 'SOL': 'SOL-USD', 'BNB': 'BNB-USD',
    'XRP': 'XRP-USD', 'DOGE': 'DOGE-USD', 'ADA': 'ADA-USD', 'LTC': 'LTC-USD',
    'DOT': 'DOT-USD', 'TRX': 'TRX-USD', 'SHIB': 'SHIB-USD',
    'AVAX': 'AVAX-USD', 'LINK': 'LINK-USD',
}


def symbol(query, policy=None):
    equity = query.instrument == 'equity' and (
        query.kind == 'latest' and query.frame == 'latest' and query.adjust == 'none' and (query.session == 'REGULAR' or query.market == 'US' and query.session in ('PRE','AFTER'))
        or query.kind == 'bars' and query.frame == 'day' and query.adjust in ('none', 'qfq') and query.session == 'REGULAR'
    )
    if equity:
        aliases = getattr(policy, 'source_symbols', ())
        matches = [item[2] for item in aliases if isinstance(item, (list, tuple)) and len(item) == 3
                   and tuple(item[:2]) == (query.market, query.code)]
        if len(matches) > 1:
            raise ValueError('provider_symbol_mapping_ambiguous')
        if matches:
            candidate = matches[0]
            # Operator-declared Korean board mapping cannot change the underlying security code.
            if query.market != 'KR' or candidate not in (query.code + '.KS', query.code + '.KQ'):
                raise ValueError('provider_symbol_mapping_invalid')
            return candidate, 'EQUITY_OR_ETF'
        if query.market == 'US':
            return query.code.replace('.', '-'), 'EQUITY_OR_ETF'
        if query.market == 'HK' and query.code.isdigit():
            return query.code.lstrip('0').zfill(4) + '.HK', 'EQUITY_OR_ETF'
        if query.market == 'CN' and query.code.isdigit():
            suffix = '.BJ' if query.code.startswith(('4', '8', '920')) else '.SS' if query.code.startswith(('6', '9')) else '.SZ'
            return query.code + suffix, 'EQUITY_OR_ETF'
        if query.market == 'JP':
            return query.code + '.T', 'EQUITY_OR_ETF'
        if query.market == 'KR' and query.code.isdigit():
            return query.code + '.KS', 'EQUITY_OR_ETF'
        raise ValueError('fixed_latest_instrument_unknown')
    if (query.kind, query.frame, query.adjust, query.session) != ('bars', 'day', 'none', 'REGULAR'):
        raise ValueError('yahoo_history_semantics_not_installed')
    if query.instrument == 'index':
        matches = [value[2] for value in INDEXES.values() if value[:2] == (query.market, query.code)]
        if len(matches) == 1:
            return matches[0], 'INDEX'
    if query.instrument == 'asset' and query.market == 'ASSET' and query.code in CRYPTOS:
        return CRYPTOS[query.code], 'CRYPTOCURRENCY'
    raise ValueError('fixed_history_instrument_unknown')


def installed(query, policy=None):
    try:
        symbol(query, policy)
        return True
    except ValueError:
        return False


def page_window(query, cursor):
    begin, through = date.fromisoformat(query.start), date.fromisoformat(query.through)
    start = date.fromisoformat(cursor) if cursor is not None else begin
    if not begin <= start <= through:
        raise ValueError('history_cursor_outside_window')
    end = min(through, start + timedelta(days=365))
    return start, end, (end + timedelta(days=1)).isoformat() if end < through else None


async def fetch(target, query, cursor, policy=None):
    provider_symbol, _ = symbol(query, policy)
    if (target.source != 'yahoo' or target.host.lower() not in ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')
            or target.scheme != 'https' or target.port != 443):
        raise ValueError('yahoo_history_fixed_origin_required')
    if query.kind == 'latest':
        if cursor is not None:
            raise ValueError('latest_has_no_cursor')
        extended=query.session in ('PRE','AFTER')
        parameters = urlencode({'range': '1d', 'interval': '1m' if extended else '1d', 'includePrePost': 'true' if extended else 'false'})
    else:
        start, end, _ = page_window(query, cursor)
        zone = ZoneInfo(ZONES[query.market])
        first = datetime.combine(start, datetime.min.time(), zone)
        after = datetime.combine(end + timedelta(days=1), datetime.min.time(), zone)
        parameters = urlencode({'period1': int(first.timestamp()), 'period2': int(after.timestamp()),
                                'interval': '1d', 'includePrePost': 'false',
                                'includeAdjustedClose': 'true' if query.instrument == 'equity' and query.adjust == 'qfq' else 'false'})
    url = f'https://{target.host}{target.path(provider_symbol)}?{parameters}'
    # Approval includes exact escaped path and operator-pinned addresses, never a caller URL.
    return await fetch_page(url, target.approval(provider_symbol)), 'http_response_body'


def extended_quote(result,meta,query,provider_symbol):
    """Actual pre/post minute closes, never an overnight or synthetic PRE mark."""
    timestamps=result.get('timestamp')
    indicators=result.get('indicators')
    quotes=indicators.get('quote') if isinstance(indicators,dict) else None
    closes=quotes[0].get('close') if isinstance(quotes,list) and len(quotes)==1 and isinstance(quotes[0],dict) else None
    if (not isinstance(timestamps,list) or len(timestamps)>2000 or not isinstance(closes,list)
        or len(closes)!=len(timestamps)):
        raise ValueError('source_extended_series_shape')
    zone=ZoneInfo(ZONES['US']);today=datetime.now(UTC).astimezone(zone).date()
    points=[];issues=[]
    for position,(epoch,raw_price) in enumerate(zip(timestamps,closes)):
        if raw_price is None:continue
        try:
            if type(epoch) is not int:raise ValueError('source_extended_time_invalid')
            stamp=datetime.fromtimestamp(epoch,UTC);local=stamp.astimezone(zone)
            minute=local.hour*60+local.minute
            selected=240<=minute<570 if query.session=='PRE' else 960<=minute<1200
            if local.date()!=today or not selected:continue
            points.append((stamp,number(raw_price,positive=True)))
        except (ValueError,TypeError,OverflowError,OSError):
            issues.append({'position':position,'reason':'source_extended_record_invalid'})
    if not points:return [],issues+[{'reason':'source_extended_observation_unavailable'}],None
    stamp,price=max(points,key=lambda point:point[0])
    # Conflicting closes at the identical timestamp are not resolved by ordering.
    if len({value for at,value in points if at==stamp})!=1:raise ValueError('source_extended_same_time_ambiguous')
    fact={'at':stamp.isoformat(),'currency':'USD','marketTimezone':ZONES['US'],
          'source':'yahoo','sourceVersion':VERSION,'sourceSymbol':provider_symbol,
          'price':str(price),'name':meta.get('longName') or meta.get('shortName') or '',
          'session':query.session,'requestedSession':query.session,'cached':None,'providerCacheState':'unknown',
          'priceField':'indicators.quote.close','priceBasis':'provider_one_minute_close',
          'sourceTimestampAuthority':'provider_one_minute_bar_not_individual_trade_time',
          'sessionWindowAuthority':'source_bar_new_york_clock_window_not_verified_trading_calendar',
          'individualSessionTradeTimeKnown':False,'equityValid':meta['instrumentType']=='EQUITY',
          'fundValid':meta['instrumentType']=='ETF','snapshotMetricsVersion':1}
    fields=('regularMarketPrice','previousClose','chartPreviousClose') if query.session=='PRE' else ('previousClose','chartPreviousClose','regularMarketPrice')
    for field in fields:
        try:baseline=number(meta.get(field),positive=True)
        except (ValueError,TypeError,OverflowError):continue
        # A future/same-day regular price cannot become the preceding PRE close.
        if query.session=='PRE' and field=='regularMarketPrice':
            epoch=meta.get('regularMarketTime')
            if type(epoch) is not int:continue
            try:baseline_at=datetime.fromtimestamp(epoch,UTC)
            except (ValueError,OverflowError,OSError):continue
            if baseline_at>=stamp or baseline_at.astimezone(zone).date()>=today:continue
            fact['baselineAt']=baseline_at.isoformat()
        fact.update(prevClose=str(baseline),baselineField=field,changeBasis='selected_extended_close_vs_provider_'+field)
        with localcontext() as context:
            context.prec=80
            fact.update(change=str(price-baseline),changePct=str((price-baseline)/baseline*100))
        break
    if 'prevClose' not in fact:fact['baselineState']='unknown'
    # Regular OHLC, turnover and volume do not describe this extended minute.
    return [fact],issues,None


def parse(raw, query, *, cursor_in=None, policy=None):
    provider_symbol, instrument = symbol(query, policy)
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= 131072:
        raise ValueError('yahoo_history_response_size')
    payload = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non_finite')))
    chart = payload.get('chart') if isinstance(payload, dict) else None
    results = chart.get('result') if isinstance(chart, dict) and chart.get('error') is None else None
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise ValueError('yahoo_history_response_invalid')
    result = results[0]
    meta = result.get('meta')
    expected_types = ('EQUITY', 'ETF') if instrument == 'EQUITY_OR_ETF' else (instrument,)
    if (not isinstance(meta, dict) or meta.get('symbol') != provider_symbol
            or meta.get('instrumentType') not in expected_types or meta.get('currency') != CURRENCIES[query.market]):
        raise ValueError('yahoo_history_security_or_currency_mismatch')
    if query.kind == 'latest':
        if cursor_in is not None:raise ValueError('latest_has_no_cursor')
        if query.session in ('PRE','AFTER'):return extended_quote(result,meta,query,provider_symbol)
        if cursor_in is not None or type(meta.get('regularMarketTime')) is not int:
            raise ValueError('source_regular_quote_time_required')
        stamp = datetime.fromtimestamp(meta['regularMarketTime'], UTC)
        fact = {'at': stamp.isoformat(), 'currency': CURRENCIES[query.market], 'marketTimezone': ZONES[query.market],
                'source': 'yahoo', 'sourceVersion': VERSION, 'sourceSymbol': provider_symbol,
                'price': str(number(meta.get('regularMarketPrice'), positive=True)),
                'name': meta.get('longName') or meta.get('shortName') or '', 'session': 'REGULAR', 'cached': None,
                'priceBasis': 'provider_regular_market_quote', 'equityValid': meta['instrumentType'] == 'EQUITY',
                'fundValid': meta['instrumentType'] == 'ETF', 'snapshotMetricsVersion': 1}
        for source, field in (('regularMarketOpen', 'open'), ('regularMarketDayHigh', 'high'),
                              ('regularMarketDayLow', 'low'), ('previousClose', 'prevClose'),
                              ('regularMarketVolume', 'volume'), ('marketCap', 'marketCap'),
                              ('fiftyTwoWeekHigh', 'weekHigh'), ('fiftyTwoWeekLow', 'weekLow'),
                              ('sharesOutstanding', 'totalShares' if fact['equityValid'] else 'fundUnits')):
            if meta.get(source) is not None:
                try:
                    fact[field] = str(number(meta[source], positive=field != 'volume'))
                except (ValueError, TypeError, OverflowError):
                    pass
        return [fact], [], None
    start, end, next_cursor = page_window(query, cursor_in)
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote') if isinstance(result.get('indicators'), dict) else None
    if not isinstance(timestamps, list) or len(timestamps) > 500:
        raise ValueError('yahoo_history_timestamp_count')
    if not isinstance(quotes, list) or len(quotes) != 1 or not isinstance(quotes[0], dict):
        raise ValueError('yahoo_history_ohlc_missing')
    columns = quotes[0]
    if any(not isinstance(columns.get(key), list) or len(columns[key]) != len(timestamps)
           for key in ('open', 'high', 'low', 'close')):
        raise ValueError('yahoo_history_column_alignment')
    adjusted = None
    if query.instrument == 'equity' and query.adjust == 'qfq':
        declarations = result['indicators'].get('adjclose')
        if (not isinstance(declarations, list) or len(declarations) != 1 or not isinstance(declarations[0], dict)
                or not isinstance(declarations[0].get('adjclose'), list)
                or len(declarations[0]['adjclose']) != len(timestamps)):
            raise ValueError('provider_adjusted_close_required')
        adjusted = declarations[0]['adjclose']
    volume = columns.get('volume')
    if volume is not None and (not isinstance(volume, list) or len(volume) != len(timestamps)):
        raise ValueError('yahoo_history_volume_alignment')
    facts, issues, seen = [], [], set()
    for position, epoch in enumerate(timestamps):
        try:
            if type(epoch) is not int:
                raise ValueError('source_timestamp_invalid')
            stamp = datetime.fromtimestamp(epoch, UTC)
            local_day = stamp.astimezone(ZoneInfo(ZONES[query.market])).date()
            if not start <= local_day <= end or epoch in seen:
                raise ValueError('source_date_or_duplicate_invalid')
            seen.add(epoch)
            values = {key: number(columns[source][position], positive=True)
                      for key, source in (('o', 'open'), ('h', 'high'), ('l', 'low'), ('c', 'close'))}
            if values['h'] < max(values.values()) or values['l'] > min(values.values()):
                raise ValueError('source_ohlc_inconsistent')
            adjustment = {}
            if adjusted is not None:
                actual_adjusted_close = number(adjusted[position], positive=True)
                adjustment = {'sourceClose': str(values['c']), 'sourceAdjustedClose': str(actual_adjusted_close),
                              'adjustmentMethod': 'provider_adjusted_close_ratio', 'volumeBasis': 'provider_reported'}
                with localcontext() as decimal_context:
                    decimal_context.prec = 64
                    factor = actual_adjusted_close / values['c']
                    adjustment['adjustmentFactor'] = str(factor)
                    source_close = values['c']
                    values = {key: actual_adjusted_close if value == source_close
                              else number(str(value * factor), positive=True)
                              for key, value in values.items()}
                if values['h'] < max(values.values()) or values['l'] > min(values.values()):
                    raise ValueError('adjusted_ohlc_precision_inconsistent')
            fact = {'at': stamp.isoformat(), 'currency': CURRENCIES[query.market],
                    'marketTimezone': ZONES[query.market], 'source': 'yahoo', 'sourceVersion': VERSION,
                    'session': 'REGULAR', 'instrument': query.instrument, 'sourceSymbol': provider_symbol,
                    'sourceInstrumentType': meta['instrumentType'],
                    'corporateAdjustment': 'source_adjusted_close' if adjusted is not None else 'provider_reported' if query.instrument == 'equity' else 'not_applicable',
                    **{key: str(value) for key, value in values.items()}, **adjustment}
            if volume is not None and volume[position] is not None:
                fact['v'] = str(number(volume[position]))
            facts.append(fact)
        except (ValueError, TypeError, OverflowError, OSError):
            issues.append({'position': position, 'reason': 'source_record_invalid_or_unknown'})
    return facts, issues, next_cursor
