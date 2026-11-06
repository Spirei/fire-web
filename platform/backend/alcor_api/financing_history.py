"""Prove existing recorded negative cash without manufacturing loan authority."""
from collections import defaultdict
from decimal import Decimal, localcontext

from fastapi import HTTPException


async def nonincreasing_debt_history(conn, owner, account, currency, original, replacement, *, baseline=None, additional_confirmed=False):
    """A correction may reduce proven debt, but cannot move or enlarge it.

    Financial event ordering is checked by the caller. Cash proof compares every
    affected instant, including instants removed from the replacement history.
    """
    rows=[row for row in original if row['account_id']==account and row['currency']==currency]
    proofs=await(await conn.execute('SELECT f.*,e.occurred_at FROM cash_financing_confirmations f JOIN cash_ledger_entries e ON e.owner_id=f.owner_id AND e.id=f.entry_id WHERE f.owner_id=%s AND f.account_id=%s AND f.currency=%s',(owner,account,currency))).fetchall()
    by_id={row['entry_id']:row for row in proofs}
    with localcontext() as context:
        context.prec=80
        running=Decimal(0)
        for row in sorted(rows,key=lambda item:(item['occurred_at'],item['created_at'],str(item['id']))):
            after=running+row['amount']
            if after<0 and row['amount']<0:
                proof=by_id.get(row['id'])
                if not proof or proof['before_balance']!=running or proof['after_balance']!=after or proof['amount']!=row['amount']:
                    raise HTTPException(409,'原历史负现金缺少逐笔明确融资依据，不能据此更正')
            running=after
        old=defaultdict(lambda:Decimal(0));new=defaultdict(lambda:Decimal(0))
        if baseline is None:
            for row in rows:old[row['occurred_at']]+=row['amount']
        else:
            for occurred,created,identity,amount in baseline:old[occurred]+=amount
        for occurred,created,identity,amount in replacement:new[occurred]+=amount
        before=after=Decimal(0)
        for instant in sorted(old.keys()|new.keys()):
            before+=old[instant];after+=new[instant]
            if after<min(before,Decimal(0)) and not additional_confirmed:
                raise HTTPException(409,'更正将增加或提前历史融资，须另行明确核实实际融资依据')
        return running
