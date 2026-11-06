"""Independent original TypeScript body, with pinned source/excerpt evidence."""
import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from alcor_api.internal_order_observations import condition_matches


def test_original_orders_types_fixed_thresholds_match_decimal_observer():
    here=Path(__file__).parent
    fixture=here/'orders-condition-source.js'
    evidence=json.loads((here/'orders-condition-evidence.json').read_text())
    assert hashlib.sha256(fixture.read_bytes()).hexdigest()==evidence['fixtureSha256']
    cases=[{'side':side,'orderType':kind,'price':10,'triggerPrice':trigger,'live':live}
           for side in ('buy','sell') for kind in ('limit','trigger_buy','trigger_sell','rebound_buy','rebound_sell')
           for trigger in (None,9) for live in (8,9,10,11)]
    script="const fill=require(process.argv[1]);const rows=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(rows.map(r=>fill(r,r.live))));"
    expected=json.loads(subprocess.check_output(['node','-e',script,str(fixture.resolve()),json.dumps(cases)],text=True))
    actual=[condition_matches(row['orderType'],row['side'],row['price'],row['triggerPrice'],row['live']) for row in cases]
    assert actual==expected


@pytest.mark.parametrize('market,currency',[('JP','JPY'),('KR','KRW'),('SG','SGD'),('UK','GBP')])
def test_explicit_new_market_paid_fees_need_matching_original_currency_and_never_new_rules(market,currency):
    from alcor_api.current_fees import calculate
    record={'market':market,'account_market':'','broker_account_id':'account'}
    account={'id':'account','provider_id':'ibkr','holding_source':'manual','revision':1}
    manual={'source':'owner_recorded','brokerAccountId':'account','providerId':'ibkr','confirmed':True,
            'components':[{'kind':'actual_paid','amount':'1.00000001','currency':currency}]}
    data={'fees':'1.00000001','occurredAt':'2026-11-03T00:00:00Z'}
    out=calculate(data,record,account,manual)
    assert out['total']=='1.00000001' and out['currency']==currency and out['ruleVersion'] is None
    with pytest.raises(ValueError,match='fee_currency_mismatch'):
        calculate(data,record,account,{**manual,'components':[{'kind':'actual_paid','amount':'1.00000001','currency':'USD'}]})
    with pytest.raises((ValueError,TypeError,KeyError)):
        calculate({'fees':None},record,account,manual)
    with pytest.raises(KeyError):
        calculate({},record,account,manual)
    estimate={key:value for key,value in manual.items() if key!='components'}
    estimate.update(source='rule_calculated',ruleVersion='2026-10-23.1',instrumentKind='us_domestic_equity',plan={'effectiveFrom':'2025-07-01','effectiveThrough':'2026-12-31','overrides':{}})
    with pytest.raises(ValueError,match='fee_rule_market_unsupported'):
        calculate(data,record,account,estimate)
