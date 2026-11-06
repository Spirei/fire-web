"""Exact owner-declared financing metadata and signed-cash debt; no broker action."""
import hashlib
import json
from decimal import Decimal, InvalidOperation, localcontext
from fractions import Fraction

from fastapi import HTTPException

CURRENCIES=('USD','EUR','HKD','MOP','CNY','JPY','KRW','SGD','GBP','AUD','CAD','TWD','CHF','INR','BRL')
MAX=Decimal(9007199254740991)


def amount(value,*,nullable=False):
    if nullable and value is None:return None
    if not isinstance(value,str) or not 1<=len(value)<=96 or value.strip()!=value:raise HTTPException(422,'融资金额须为精确十进制文本')
    try:
        result=Decimal(value)
        if not result.is_finite() or result<0 or result>MAX or result.as_tuple().exponent < -18:raise InvalidOperation()
    except InvalidOperation:raise HTTPException(422,'融资金额超出精确记账范围') from None
    with localcontext() as context:
        context.prec=80
        return format(result.normalize(),'f') if result else '0'


def policy(value):
    if not isinstance(value,dict) or set(value)!={'currency','limit','initialMargin','maintenanceMargin'} or value['currency'] not in CURRENCIES:raise HTTPException(422,'融资币种或政策字段无效')
    result={'currency':value['currency'],**{key:amount(value[key],nullable=True) for key in ('limit','initialMargin','maintenanceMargin')}}
    initial=result['initialMargin'];maintenance=result['maintenanceMargin']
    if (initial is None)!=(maintenance is None) or maintenance is not None and (Decimal(maintenance)<=0 or Decimal(initial)<Decimal(maintenance)):raise HTTPException(422,'保证金金额须成对填写，初始金额不能低于维持金额')
    return result


def revision(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def debt(balances,currency,rates):
    """Owner NET cash by currency, matching the old explicit policy basis.

    Positive other-currency cash does not cancel a negative liability. The
    account-level view remains separately identified and is never summed twice.
    Exact source ratios are used, with no fallback or rounded comparison.
    """
    if currency not in CURRENCIES:raise ValueError('unsupported_policy_currency')
    total=Fraction(0)
    for code,value in balances.items():
        if value is None:raise ValueError('cash_scope_unknown')
        value=Decimal(value)
        if not value.is_finite():raise ValueError('cash_scope_unknown')
        if value>=0:continue
        change=Fraction(value.copy_negate())
        if code!=currency:
            source=rates.get(code);target=rates.get(currency)
            if source is None or target is None or source<=0 or target<=0:raise ValueError('recorded_exchange_rate_missing')
            change=change/Fraction(source)*Fraction(target)
        total+=change
    return total


def decimal_text(value):
    with localcontext() as context:
        context.prec=80
        return str(Decimal(value.numerator)/Decimal(value.denominator))


def confirmation(value):
    fields={'kind','statement','actualBorrowingConfirmed','ledgerOnlyConfirmed'}
    if not isinstance(value,dict) or set(value)!=fields or value['kind']!='owner_statement' or value['actualBorrowingConfirmed'] is not True or value['ledgerOnlyConfirmed'] is not True:raise HTTPException(422,'须本人明确核实已发生融资或实际负现金，仅登记内部账本')
    statement=value['statement']
    if not isinstance(statement,str) or not 1<=len(statement.strip())<=4096 or any(ord(c)<32 and c not in '\n\t' for c in statement) or '\x7f' in statement:raise HTTPException(422,'请填写原融资或负余额的本人核对依据')
    return {**value,'statement':statement}


def effect(before,after):
    with localcontext() as context:
        context.prec=80
        before=Decimal(before);after=Decimal(after)
        debt_before=max(Decimal(0),-before);debt_after=max(Decimal(0),-after)
        return {'cashBefore':str(before),'cashAfter':str(after),'debtBefore':str(debt_before),'debtAfter':str(debt_after),'debtChange':str(debt_after-debt_before),'externalFlow':'0','income':'0','brokerExecution':False,'basis':'account_negative_cash_observation','brokerLoanVerified':False}
