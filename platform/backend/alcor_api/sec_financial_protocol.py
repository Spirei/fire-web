"""Company Facts observations: source units/revisions, without quarter arithmetic."""

import json
import math
import re
from datetime import date
from decimal import Decimal

from .fx_provider_parser import unique
from .sec_company_protocol import LIMIT, Target, company_directory

SOURCE = 'sec-companyfacts-v1'
PURPOSE = 'financials'
METRICS = {
    'revenue': (('RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'), 'USD'),
    'grossProfit': (('GrossProfit',), 'USD'),
    'operatingIncome': (('OperatingIncomeLoss',), 'USD'),
    'netIncome': (('NetIncomeLoss', 'ProfitLoss'), 'USD'),
    'eps': (('EarningsPerShareDiluted', 'EarningsPerShareBasic'), 'USD/shares'),
    'assets': (('Assets',), 'USD'),
    'liabilities': (('Liabilities',), 'USD'),
    'cash': (('CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'), 'USD'),
    'operatingCashFlow': (('NetCashProvidedByUsedInOperatingActivities',), 'USD'),
    'capex': (('PaymentsToAcquirePropertyPlantAndEquipment',), 'USD'),
    'dividendsPerShare': (('CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'), 'USD/shares'),
    'productRevenue': (('SalesRevenueProductsNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'), 'USD'),
    'serviceRevenue': (('SalesRevenueServicesNet',), 'USD'),
    'costOfRevenue': (('CostOfRevenue', 'CostOfGoodsAndServicesSold'), 'USD'),
    'rdExpense': (('ResearchAndDevelopmentExpense',), 'USD'),
    'sgaExpense': (('SellingGeneralAndAdministrativeExpense',), 'USD'),
    'incomeTax': (('IncomeTaxExpenseBenefit',), 'USD'),
}


def code(value):
    if not isinstance(value, str) or not value.isascii() or not re.fullmatch(r'[A-Z0-9._-]{1,40}', value.upper(), re.ASCII):
        raise ValueError('sec_financial_code')
    return value.upper()


def lookup_code(value):
    return re.sub(r'\.(OQ|N|AM|PS|K)$', '', code(value))


def directory_entry(raw, symbol):
    return company_directory(raw).get(lookup_code(symbol))


class FinancialTarget(Target):
    def request(self, cik=None):
        url, approval = super().request(cik)
        if cik is not None:
            path = f'/api/xbrl/companyfacts/CIK{cik}.json'
            url = 'https://data.sec.gov'+path
            approval['target'] = ('https', 'data.sec.gov', 443, path)
        return url, approval


def iso_day(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value, re.ASCII):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def quarterly(facts, names, unit):
    # Original protocol chooses the first existing concept, not the first with data.
    concept = next((name for name in names if isinstance(facts.get(name), dict)), None)
    fact = facts.get(concept, {})
    units = fact.get('units', {})
    units = units if isinstance(units, dict) else {}
    rows = units.get(unit, [])
    if not isinstance(rows, list) or len(rows) > 100000:
        raise ValueError('sec_fact_rows_budget_or_shape')
    eligible, issues = [], 0
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            issues += 1
            continue
        if row.get('val') is None or row.get('fp') == 'FY' or row.get('form') not in ('10-Q', '10-K') or not row.get('end'):
            continue
        value = row['val']
        if (type(value) not in (int, Decimal) or not iso_day(row['end'])
                or ('filed' in row and not iso_day(row['filed']))
                or ('start' in row and not iso_day(row['start']))
                or ('fy' in row and type(row['fy']) is not int)
                or ('fp' in row and not isinstance(row['fp'], str))
                or any(key in row and not isinstance(row[key], str) for key in ('form', 'accn', 'frame'))):
            issues += 1
            continue
        try:
            number = float(value)
            if not math.isfinite(number):
                raise ValueError('nonfinite')
        except (ValueError, OverflowError):
            issues += 1
            continue
        eligible.append((index, row, number))
    # Stable sorting preserves original row-order tie behavior and last revision.
    eligible.sort(key=lambda item: item[1].get('filed', 'undefined'))
    selected = {}
    for item in eligible:
        selected[(item[1]['end'], item[1].get('fp') or '')] = item
    values = sorted(selected.values(), key=lambda item: item[1]['end'])[-8:]
    projected, evidence = [], []
    for index, row, number in values:
        point = {'period': row['end'], 'value': row['val'] if type(row['val']) is int else number}
        for source, target in (('fy', 'fiscalYear'), ('fp', 'fiscalPeriod')):
            if source in row:
                point[target] = row[source]
        projected.append(point)
        evidence.append({'rowIndex': index, 'valueText': str(row['val']),
                         **{key: row.get(key) for key in ('start', 'end', 'filed', 'form', 'accn', 'frame', 'fy', 'fp')}})
    return projected, {'concept': concept, 'taxonomy': 'us-gaap', 'unit': unit,
                       'state': 'observed' if values else 'missing', 'selected': evidence,
                       'sourceRows': len(rows), 'rejectedRows': issues, 'availableUnits': sorted(units),
                       'selection': 'last_filed_revision_per_end_and_fp_last_8',
                       'durationInterpretation': 'as_filed_no_ytd_to_quarter_conversion'}


def project(raw, entry, symbol):
    if not isinstance(raw, bytes) or not raw or len(raw) > LIMIT:
        raise ValueError('sec_financial_page_budget')
    body = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
    if not isinstance(body, dict):
        raise TypeError('sec_companyfacts_shape')
    cik = body.get('cik')
    if type(cik) not in (str, int) or not str(cik).isascii() or not str(cik).isdigit() or str(cik).zfill(10) != entry['cik']:
        raise ValueError('sec_companyfacts_identity')
    all_facts = body.get('facts')
    if not isinstance(all_facts, dict):
        raise TypeError('sec_companyfacts_facts_missing')
    facts = all_facts.get('us-gaap', {})
    if not isinstance(facts, dict):
        raise TypeError('sec_usgaap_shape')
    metrics, observations = {}, {}
    for name, (concepts, unit) in METRICS.items():
        metrics[name], observations[name] = quarterly(facts, concepts, unit)
    name = body.get('entityName')
    return {'supported': True, 'market': 'US', 'code': code(symbol),
            'company': name if isinstance(name, str) and name else code(symbol),
            'currency': 'USD', 'source': 'SEC Company Facts', 'metrics': metrics,
            'migration': {'cik': entry['cik'], 'ticker': entry['ticker'], 'metricObservations': observations,
                          'allOriginalRevisionsPreservedInSourcePage': True,
                          'calendarEventDateKnown': False, 'taxonomyScope': 'us-gaap',
                          'otherUnitsNotConverted': True, 'fullFinancialHistoryVerified': False}}
