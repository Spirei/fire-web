import hashlib
import json
from pathlib import Path

import pytest
from alcor_api.sec_company_protocol import Target, company_directory, submissions
from alcor_api.sec_company_service import project


def encoded(value):
    return json.dumps(value).encode()


def test_full_directory_identity_is_independent_of_observed_or_curated_codes():
    entry = company_directory(encoded({'0': {'cik_str': 1234567, 'title': 'Unobserved Corp', 'ticker': 'ZZZX'}}))['ZZZX']
    sec = submissions(encoded({'cik': '1234567', 'tickers': ['ZZZX'], 'name': 'Unobserved Corp', 'exchanges': ['NYSE'], 'fiscalYearEnd': '1231', 'sicDescription': 'Prepackaged Software'}), entry)
    result = project(sec, entry)
    assert result['symbol'] == 'ZZZX.US' and result['company'] == 'Unobserved Corp'
    assert result['industry'] == '软件' and result['exchange'] == '纽约证券交易所'
    assert result['description'] == '' and result['founded'] == '—'
    assert result['migration']['sourceTimeKnown'] is False
    for body in ({'cik': 7654321, 'tickers': ['ZZZX']}, {'cik': 1234567, 'tickers': ['OTHER']}):
        with pytest.raises(ValueError):
            submissions(encoded(body), entry)


def test_directory_collisions_and_noninteger_cik_are_not_silently_accepted():
    for rows in ({'0': {'cik_str': True, 'title': 'X', 'ticker': 'X'}},
                 {'0': {'cik_str': 1, 'title': 'X', 'ticker': 'X'}, '1': {'cik_str': 2, 'title': 'Y', 'ticker': 'X'}}):
        with pytest.raises(ValueError):
            company_directory(encoded(rows))


def test_fixed_targets_require_public_pins_and_declared_operator_identity():
    target = Target('sec', ('8.8.8.8',), ('1.1.1.1',), 'Example contact@example.invalid')
    assert target.request()[0] == 'https://www.sec.gov/files/company_tickers.json'
    assert target.request('0000123456')[0] == 'https://data.sec.gov/submissions/CIK0000123456.json'
    for cik in ('../other', '123', '１２３４５６７８９０'):
        with pytest.raises(ValueError):
            target.request(cik)
    with pytest.raises(ValueError):
        Target('sec', ('127.0.0.1',), ('1.1.1.1',), target.user_agent).validate()
    with pytest.raises(ValueError):
        Target('sec', target.directory_addresses, target.submissions_addresses, 'undeclared').validate()


def test_frozen_original_source_hashes_and_explicit_editorial_fields():
    root = Path(__file__).resolve().parents[1] / 'fixtures/sec-company-source'
    for name, expected in json.loads((root / 'source-sha256.json').read_text()).items():
        assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected
    result = project({'name': 'Apple Inc.', 'cik': 320193}, {'ticker': 'AAPL', 'title': 'Apple Inc.'})
    assert result['founded'] == '1976'
    assert result['migration']['foundedState'] == 'legacy_editorial'
