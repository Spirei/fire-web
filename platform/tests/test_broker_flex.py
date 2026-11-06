"""Offline source-integrity checks, no external service or financial writes."""
import hashlib

import pytest
from fastapi import HTTPException
from alcor_api.broker_flex import parse_flex


def xml(body='', *, account='SYNTHETIC', end='20260131'):
    return (f'<FlexQueryResponse><FlexStatements><FlexStatement accountId="{account}" fromDate="20260101" toDate="{end}"><OpenPositions/>{body}</FlexStatement></FlexStatements></FlexQueryResponse>').encode()


def test_exact_cash_and_raw_event_fields_are_preserved_without_replay():
    raw = xml('<CashReportCurrency currency="USD" endingCash="0.000000000000000001"/>'
              '<Trade levelOfDetail="EXECUTION" transactionID="tx-1" quantity="2" ibCommission=""/>'
              '<CashTransaction amount="100"/>')
    result = parse_flex(raw, 'SYNTHETIC')
    assert result['cash'] == [{'currency': 'USD', 'endingCash': '0.000000000000000001'}]
    assert result['events'] == [{'id': 'Trade:tx-1', 'kind': 'Trade', 'data': {'ibCommission': '', 'levelOfDetail': 'EXECUTION', 'quantity': '2', 'transactionID': 'tx-1'}}]
    assert result['sourceSha256'] == hashlib.sha256(raw).hexdigest()
    assert result['positions'] == [] and result['financialEffect'] == 'none'
    assert any('未收录' in warning for warning in result['warnings'])


@pytest.mark.parametrize('raw', [
    b'<!DOCTYPE x [<!ENTITY e "private">]><FlexQueryResponse/>',
    xml('<CashReportCurrency accountId="OTHER" currency="USD" endingCash="0"/>'),
    xml('<FinancialInstrument accountId="OTHER" conid="1" listingExchange="NYSE"/>'),
    xml('<CashReportCurrency currency="USD" endingCash="NaN"/>'),
    xml('<CashReportCurrency currency="USD" endingCash="1e999999"/>'),
    xml('<CashReportCurrency currency="USD" endingCash="0"/><CashReportCurrency currency="USD" endingCash="1"/>'),
    xml(end='20260230'),
])
def test_bad_or_ambiguous_sources_reject_without_a_preview(raw):
    with pytest.raises(HTTPException) as error:
        parse_flex(raw, 'SYNTHETIC')
    assert error.value.status_code == 422


def test_missing_cash_remains_unknown_and_other_account_is_not_selected():
    result = parse_flex(xml(), 'SYNTHETIC')
    assert result['cash'] == [] and any('未提供' in w for w in result['warnings'])
    with pytest.raises(HTTPException):
        parse_flex(xml(account='OTHER'), 'SYNTHETIC')
