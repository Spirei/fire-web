import json
import subprocess
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path

import pytest
from alcor_api.financing_model import CURRENCIES, debt, effect, policy
from fastapi import HTTPException


def test_exact_original_fifteen_currency_policy_and_negative_cash_debt_goldens():
    original=json.loads(subprocess.check_output(['node',str(Path(__file__).parent/'financing_candidate/run_old_golden.cjs')],cwd=Path(__file__).resolve().parents[1],text=True))
    frozen=json.loads((Path(__file__).parent/'fixtures/financing-legacy-golden.json').read_text())
    assert original==frozen
    assert {p['currency'] for p in original['policies']}==set(CURRENCIES)
    for old in original['policies']:
        new=policy({key:str(value) if key!='currency' and value is not None else value for key,value in old.items()})
        assert new['currency']==old['currency'] and Decimal(new['initialMargin'])==20 and Decimal(new['maintenanceMargin'])==10
    for vector in original['debts']:
        actual=debt({key:str(value) for key,value in vector['balances'].items()},vector['currency'],{key:Fraction(str(value)) for key,value in vector['rates'].items()})
        assert abs(float(actual)-vector['value'])<1e-10
    with pytest.raises(ValueError,match='recorded_exchange_rate_missing'):debt({'JPY':'-1'},'USD',{'USD':Fraction(1)})
    with pytest.raises(HTTPException):policy({'currency':'USD','limit':None,'initialMargin':'1','maintenanceMargin':'2'})


def test_debt_and_cash_liability_conservation_do_not_depend_on_ambient_decimal_precision():
    results=[]
    for precision in (6,28,80):
        with localcontext() as context:
            context.prec=precision
            results.append(debt({'USD':'-9007199254740990.123456789012345678','JPY':'-15000.000000000000000001'},'CHF',{'USD':Fraction(1),'JPY':Fraction(150),'CHF':Fraction(9,10)}))
            value=effect('1000','-101')
            assert value['debtChange']=='101' and value['externalFlow']==value['income']=='0'
    assert results[0]==results[1]==results[2]
