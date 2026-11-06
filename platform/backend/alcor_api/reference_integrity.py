"""Pure retained-reference verification. No credentials, collection or replacement facts."""

import hashlib
import json
from datetime import datetime
from decimal import Decimal, localcontext
from fractions import Fraction


def fx_observation(row, values, config=None):
    from .fx_provider_parser import parse, source_time
    from .fx_reference import PROVIDER, URI, parse_raw

    raw=bytes(row['original_bytes'])
    if hashlib.sha256(raw).hexdigest()!=row['raw_sha256'] or row['base_currency']!='USD':
        raise ValueError('reference_original_integrity')
    if row['provider']==PROVIDER and row.get('provider_revision') is None:
        parsed=parse_raw(raw,row['received_at'])
        if row['source_uri']!=URI or row['observation_date']!=parsed['date'] or row.get('source_instant') is not None or row.get('source_precision','date')!='date':
            raise ValueError('reference_source_binding')
        normalized=parsed['normalized_sha']
        expected={key:Fraction(value) for key,value in parsed['rates'].items()}
        displays=parsed['rates']
    elif row['provider']=='custom' and row.get('provider_revision') is not None and isinstance(config,dict):
        if row['source_uri']!=config['url']:
            raise ValueError('reference_provider_binding')
        ratios=parse(raw,config.get('declared_base'))['usd_ratios']
        normalized=hashlib.sha256(json.dumps({key:[str(value.numerator),str(value.denominator)] for key,value in ratios.items()},sort_keys=True).encode()).hexdigest()
        precision,observed=source_time(json.loads(raw,parse_float=Decimal),config.get('time_field'),config.get('time_precision'))
        observed_date=observed if precision=='date' else None
        instant=datetime.fromisoformat(observed) if precision=='instant' else None
        if (row.get('source_precision'),row['observation_date'].isoformat() if row['observation_date'] else None,row.get('source_instant'))!=(precision,observed_date,instant):
            raise ValueError('reference_source_time_binding')
        expected={key:value for key,value in ratios.items() if key!='USD'}
        with localcontext() as context:
            context.prec=50
            displays={key:Decimal(value.numerator)/Decimal(value.denominator) for key,value in expected.items()}
    else:
        raise ValueError('reference_provider_unavailable')
    if normalized!=row['normalized_sha256'] or {item['currency'] for item in values}!=set(expected) or len(values)!=len(expected):
        raise ValueError('reference_projection_integrity')
    for item in values:
        key=item['currency']
        if item['rate']!=displays[key]:
            raise ValueError('reference_display_integrity')
        if item.get('numerator') is not None or item.get('denominator') is not None:
            if item.get('numerator') is None or item.get('denominator') is None:
                raise ValueError('reference_ratio_integrity')
            numerator,denominator=int(item['numerator']),int(item['denominator'])
            if numerator!=item['numerator'] or denominator!=item['denominator'] or Fraction(numerator,denominator)!=expected[key]:
                raise ValueError('reference_ratio_integrity')
        elif row['provider']=='custom':
            raise ValueError('reference_exact_ratio_missing')


def calendar_release(row):
    raw=bytes(row['original_bytes'])
    if not 1<=len(raw)<=2_000_000 or hashlib.sha256(raw).hexdigest()!=row['original_sha256']:
        raise ValueError('calendar_original_integrity')
    value=json.loads(raw)
    cfg=value['configuration']
    if cfg['schema_version']!=1 or cfg['calendar_version']!=row['revision'] or {item['market'] for item in cfg['markets']}!={'CN','HK','US'}:
        raise ValueError('calendar_original_binding')
    return value


def calendar_markets(value, rows):
    expected={item['market']:item for item in value['configuration']['markets']}
    if len(rows)!=3 or {item['market'] for item in rows}!=set(expected):
        raise ValueError('calendar_market_projection_incomplete')
    for row in rows:
        source=expected[row['market']]
        if (row['name'],row['timezone'],row['exchanges'],row['verified_years'])!=(source['name'],source['time_zone'],source['exchanges'],source['verified_years']):
            raise ValueError('calendar_market_projection_integrity')


def calendar_projection(value, projected):
    expected=next((batch for batch in value['years'] if batch['year']==projected['year']),None)
    if expected is None:
        if any(cal['coverage']['status']!='unknown' or cal['sources'] or any(day['status']!='unknown' or day['isTradingDay'] is not None for day in cal['days']) for cal in projected['calendars'].values()):
            raise ValueError('calendar_unverified_year_projection')
        return
    def stable(batch):
        return {**batch,'calendars':{key:{**cal,'sources':sorted(cal['sources'],key=lambda source:source['id'])} for key,cal in batch['calendars'].items()}}
    if stable(expected)!=stable(projected):
        raise ValueError('calendar_source_projection_integrity')
