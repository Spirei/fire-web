import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from alcor_api.sec_financial_protocol import FinancialTarget, directory_entry, project
from alcor_api.sec_financial_service import FinancialStatements

ROOT = Path(__file__).resolve().parents[1] / 'fixtures/sec-financial-source'
ENTRY = {'ticker': 'ANY', 'cik': '0000123456', 'title': 'Any Corp'}


def raw(facts, **extra):
    return json.dumps({'cik': 123456, 'entityName': 'Any Corp', 'facts': {'us-gaap': facts}, **extra}).encode()


def old_quarterly(facts, names, unit):
    expected = json.loads((ROOT/'source-sha256.json').read_text())['route.ts']
    assert hashlib.sha256((ROOT/'route.ts').read_bytes()).hexdigest() == expected
    script = r'''
const ts=require('typescript'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const ctx={exports:{},require:()=>({}),Map};vm.createContext(ctx);
vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
const p=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(ctx.quarterly(p.facts,p.names,p.unit)));
'''
    completed = subprocess.run(['node', '-e', script, str(ROOT/'route.ts')],
                               input=json.dumps({'facts': facts, 'names': names, 'unit': unit}),
                               text=True, capture_output=True, check=True)
    return json.loads(completed.stdout)


def test_original_revision_selection_zeros_units_and_last_eight_are_not_quarter_arithmetic():
    rows = [{'end': f'{year}-09-30', 'start': f'{year}-01-01', 'fy': year, 'fp': 'Q3',
             'form': '10-Q', 'filed': f'{year}-11-01', 'val': year, 'accn': f'{year}-first'} for year in range(2015, 2026)]
    rows += [{'end': '2025-09-30', 'start': '2025-01-01', 'fy': 2025, 'fp': 'Q3', 'form': '10-K',
              'filed': '2026-02-01', 'val': 0, 'accn': 'last', 'frame': 'CY2025Q3'},
             {'end': '2025-12-31', 'fp': 'FY', 'form': '10-K', 'filed': '2026-02-01', 'val': 999},
             {'end': '2025-09-30', 'fp': 'Q3', 'form': '10-Q', 'filed': '2026-03-01', 'val': None}]
    facts = {'Revenues': {'units': {'USD': rows, 'EUR': [{'val': 123}]}}}
    result = project(raw(facts), ENTRY, 'ANY.OQ')
    assert result['code'] == 'ANY.OQ'
    assert result['metrics']['revenue'] == old_quarterly(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'], 'USD')
    assert len(result['metrics']['revenue']) == 8 and result['metrics']['revenue'][-1]['value'] == 0
    proof = result['migration']['metricObservations']['revenue']
    assert proof['selected'][-1]['accn'] == 'last'
    assert proof['selected'][-1]['start'] == '2025-01-01'
    assert proof['availableUnits'] == ['EUR', 'USD']
    assert result['metrics']['eps'] == [] and proof['unit'] == 'USD'
    assert result['migration']['calendarEventDateKnown'] is False


def test_first_existing_concept_and_exact_eps_unit_follow_original_source():
    facts = {'RevenueFromContractWithCustomerExcludingAssessedTax': {'units': {'EUR': []}},
             'Revenues': {'units': {'USD': [{'end': '2025-03-31', 'fp': 'Q1', 'form': '10-Q', 'val': 50}]}},
             'EarningsPerShareDiluted': {'units': {'USD/shares': [
                 {'end': '2025-03-31', 'fp': 'Q1', 'form': '10-Q', 'filed': '2025-05-01', 'val': -0.25}]}}}
    result = project(raw(facts), ENTRY, 'ANY')
    assert result['metrics']['revenue'] == old_quarterly(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'], 'USD') == []
    assert result['metrics']['eps'] == old_quarterly(facts, ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], 'USD/shares')
    assert result['migration']['metricObservations']['eps']['selected'][0]['valueText'] == '-0.25'


def test_fixed_companyfacts_target_separate_purpose_and_directory_identity():
    target = FinancialTarget('sec', ('8.8.8.8',), ('1.1.1.1',), 'Example contact@example.invalid')
    assert target.request('0000123456')[0] == 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000123456.json'
    assert FinancialStatements.purpose == 'financials'
    assert FinancialStatements.source_version == 'sec-companyfacts-v1'
    directory = json.dumps({'0': {'ticker': 'ANY', 'title': 'Any Corp', 'cik_str': 123456}}).encode()
    assert directory_entry(directory, 'any.OQ') == ENTRY
    with pytest.raises(ValueError):
        project(raw({}, cik=123457), ENTRY, 'ANY')


def test_bad_optional_observations_do_not_replace_unknown_with_zero():
    result = project(raw({'Assets': {'units': {'USD': [
        {'end': '2025-03-31', 'fp': 'Q1', 'form': '10-Q', 'val': True},
        {'end': 'invalid', 'fp': 'Q1', 'form': '10-Q', 'val': 20}]}}}), ENTRY, 'ANY')
    assert result['metrics']['assets'] == []
    assert result['migration']['metricObservations']['assets']['rejectedRows'] == 2
