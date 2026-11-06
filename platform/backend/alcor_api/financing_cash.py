"""Evidence attaches to the existing cash posting; debt is never a second balance."""
from decimal import localcontext

from psycopg.types.json import Jsonb

from .financing_model import confirmation, effect
from .source_snapshot import canonical, sha


async def attach(conn,who,data,entry_id,before,after,*,trade_id=None):
    declared=confirmation(data['financingConfirmation'])
    evidence={'requestId':data['requestId'],'entryId':str(entry_id),'accountId':data.get('accountId') or data.get('_financingAccountId'),'accountKind':data.get('accountKind') or data.get('_financingAccountKind'),'currency':data.get('settlementCurrency') or data['currency'],'confirmation':declared,'command':{key:value for key,value in data.items() if not key.startswith('_financing')},'effect':effect(before,after)}
    with localcontext() as context:
        context.prec=80
        delta=after-before
    await conn.execute('INSERT INTO cash_financing_confirmations(owner_id,request_id,entry_id,account_id,account_kind,currency,kind,trade_id,before_balance,after_balance,amount,evidence,evidence_raw,evidence_sha256) VALUES('+','.join(['%s']*14)+')',(who.id,data['requestId'],entry_id,evidence['accountId'],evidence['accountKind'],evidence['currency'],'actual_fill' if trade_id else 'cash_reconcile',trade_id,before,after,delta,Jsonb(evidence),canonical(evidence),sha(canonical(evidence))))


async def attach_correction(conn,who,data,entry_id,amendment_id,account,value):
    declared=confirmation(data['financingConfirmation'])
    before=value['cashEffect']['brokerBefore'];after=value['cashEffect']['brokerAfter'];delta=value['cashEffect']['delta']
    evidence={'requestId':data['requestId'],'entryId':str(entry_id),'amendmentId':str(amendment_id),'accountId':account['id'],'accountKind':account['account_kind'],'currency':value['cashEffect']['currency'],'confirmation':declared,'command':data,'effect':effect(before,after)}
    await conn.execute('INSERT INTO cash_financing_confirmations(owner_id,request_id,entry_id,account_id,account_kind,currency,kind,trade_id,before_balance,after_balance,amount,evidence,evidence_raw,evidence_sha256) VALUES('+','.join(['%s']*14)+')',(who.id,data['requestId'],entry_id,account['id'],account['account_kind'],value['cashEffect']['currency'],'trade_correction',data['tradeId'],before,after,delta,Jsonb(evidence),canonical(evidence),sha(canonical(evidence))))
