"""Source-bound existing accounts stay partial until every original dependency maps.

This is a read guard. It never fills missing cash, creates trades, or rewrites raw
history. Explicit independent platform entries retain their own authority.
"""
import json
from collections import Counter,defaultdict
from datetime import datetime
from decimal import Decimal,localcontext
from uuid import UUID
from .fee_estimates import value,exact
from .estimate_model import BaselineError
from .source_mapping import CURRENCY,legacy_settlement_currency


def uuid(value):
    try:return str(UUID(value))
    except (ValueError,TypeError,AttributeError):return None


def at(row,key):
    stamp=datetime.fromisoformat(value(row,key))
    if stamp.tzinfo is None:raise ValueError('source_timezone_unknown')
    return stamp


class RegisteredCoverage:
    @classmethod
    async def load(cls,conn,owner,account):
        bindings=await(await conn.execute('SELECT b.*,m.created_at cutoff FROM legacy_fee_source_account_bindings b JOIN legacy_source_manifests m ON m.owner_id=b.owner_id AND m.id=b.first_manifest_id WHERE b.owner_id=%s AND b.account_id=%s',(owner,account))).fetchall()
        if not bindings:return None
        self=cls();self.valid=False;self.owner=owner;self.account_id=account
        original=await(await conn.execute('SELECT m.* FROM legacy_source_heads h JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id WHERE h.owner_id=%s',(owner,))).fetchone()
        if not original or not original['manifest']['coverage']['complete']:return self
        identity=original['manifest']['source'];identities={(row['source_instance'],row['source_owner'],row['source_account_id']) for row in bindings}
        if len(identities)!=1 or next(iter(identities))[:2]!=(identity['instance'],identity['owner']):return self
        self.source_account=next(iter(identities))[2];self.cutoff=min(row['cutoff'] for row in bindings);self.original=original
        raw=json.loads(bytes(original['raw']));self.tables={key:item['rows'] for key,item in raw['tables'].items()}
        self.account=await(await conn.execute('SELECT * FROM broker_accounts WHERE owner_id=%s AND id=%s',(owner,account))).fetchone()
        sources=[row for row in self.tables['broker_accounts'] if value(row,'id')==self.source_account]
        if len(sources)!=1 or not self.account or value(sources[0],'account_kind')!=self.account['account_kind'] or value(sources[0],'provider_id')!=self.account['provider_id']:return self
        self.links={value(row,'order_id'):row for row in self.tables['broker_cash_order_links']}
        self.records={value(row,'id'):row for row in self.tables['records']}
        self.requests={}
        for row in self.tables['app_asset_operations']:
            try:result=json.loads(value(row,'result_json'))
            except (ValueError,TypeError):continue
            items=(result.get('data') or {}).get('items',[])
            if result.get('kind')=='submit_trade' and result.get('state')=='completed' and len(items)==1 and uuid(value(row,'request_id')):self.requests[items[0]['id']]=uuid(value(row,'request_id'))
        self.trades=await(await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND account_id=%s ORDER BY before_record_revision LIMIT 10001',(owner,account))).fetchall()
        self.cash=await(await conn.execute('SELECT e.*,o.result independent_cash_result FROM cash_ledger_entries e LEFT JOIN cash_ledger_operations o ON o.owner_id=e.owner_id AND o.request_id=e.request_id WHERE e.owner_id=%s AND e.account_id=%s ORDER BY e.created_at LIMIT 10001',(owner,account))).fetchall()
        if len(self.trades)>10000 or len(self.cash)>10000:return self
        proofs=await(await conn.execute('SELECT * FROM legacy_fee_baseline_bindings WHERE owner_id=%s AND account_id=%s AND source_instance=%s AND source_owner=%s',(owner,account,*next(iter(identities))[:2]))).fetchall()
        self.proofs={row['original_order_id']:row for row in proofs}
        from .actual_projection import confirmed_actual_fees
        verified=await confirmed_actual_fees(conn,owner)
        self.actual={row['trade_id'] for row in verified};self.actual_requests={row['request_id'] for row in verified}
        amendments=await(await conn.execute("SELECT a.id FROM trade_amendments a JOIN trade_operations o ON o.owner_id=a.owner_id AND o.request_id=a.request_id JOIN trade_ledger t ON t.owner_id=a.owner_id AND t.id=a.trade_id WHERE a.owner_id=%s AND t.account_id=%s AND o.result->>'state'='completed' AND o.result->>'kind'='trade_amendment' AND o.result->>'amendmentId'=a.id::text",(owner,account))).fetchall()
        self.amendment_ids={row['id'] for row in amendments}
        linked=await(await conn.execute('SELECT object_kind,original_id,target_id FROM financial_import_links WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(owner,*next(iter(identities))[:2]))).fetchall()
        self.imported={(row['object_kind'],row['original_id']):row['target_id'] for row in linked}
        self.by_request={str(row['request_id']):row for row in self.trades};self.by_id={str(row['id']):row for row in self.trades}
        self.trades_by_cash={row['cash_entry_id']:row for row in self.trades};self.trades_by_record=defaultdict(list)
        for row in self.trades:self.trades_by_record[row['record_id']].append(row)
        self.fund_counts=Counter(value(row,'fund_id') for row in self.tables['broker_cash_entries'] if value(row,'fund_id'))
        self.funds_by_id=defaultdict(list)
        for row in self.tables['fund_transactions']:self.funds_by_id[value(row,'id')].append(row)
        self.orders_by_record=defaultdict(list);self.source_orders=[]
        for row in self.tables['trade_orders']:
            if value(row,'status')!='filled':continue
            self.orders_by_record[value(row,'record_id')].append(row)
            if value(self.links.get(value(row,'id')),'account_id')==self.source_account or value(self.records.get(value(row,'record_id')),'broker_account_id')==self.source_account:self.source_orders.append(row)
        self.record_targets=defaultdict(set)
        for row in self.proofs.values():self.record_targets[value(row['original_row'],'record_id')].add(row['record_id'])
        for (kind,original_id),target in self.imported.items():
            if kind=='record':self.record_targets[original_id].add(target)
        self.target_sources=defaultdict(set)
        for source_id,targets in self.record_targets.items():
            for target in targets:self.target_sources[target].add(source_id)
        self.source_cash=[row for row in self.tables['broker_cash_entries'] if value(row,'account_id')==self.source_account]
        self.source_openings=defaultdict(list)
        for row in self.tables['broker_cash_accounts']:
            if value(row,'account_id')==self.source_account:self.source_openings[value(row,'currency')].append(row)
        self.cash_by_request={str(row['request_id']):row for row in self.cash};self.cash_by_id={str(row['id']):row for row in self.cash}
        self.matched_cache={};self.valid=True
        return self

    def matched_trade(self,old):
        key=id(old)
        if key not in self.matched_cache:self.matched_cache[key]=self._matched_trade(old)
        return self.matched_cache[key]

    def _matched_trade(self,old):
        oid=value(old,'id');binding=self.proofs.get(oid)
        row=self.by_request.get(self.requests.get(oid)) or self.by_id.get(str(binding['trade_id']) if binding else self.imported.get(('order',oid)))
        if not row:return None
        try:
            link=self.links.get(oid)
            if value(link,'account_id')!=self.source_account or value(link,'currency')!=row['settlement_currency'] or at(old,'traded_at')!=row['occurred_at']:return None
            for key,target in (('side','side'),('market',None),('code',None)):
                if target and value(old,key)!=row[target]:return None
            if CURRENCY.get(value(old,'market'))!=row['currency']:return None
            settlement='CNY' if value(old,'settlement_currency')=='CNY' else legacy_settlement_currency(value(old,'market'))
            if settlement!=row['settlement_currency']:return None
            for source,target in (('qty','quantity'),('price','price'),('amount','amount'),('fees','fees'),('position_qty_before','before_quantity'),('position_cost_before','before_cost'),('position_qty_after','after_quantity'),('position_cost_after','after_cost')):
                if exact(old,source)!=row[target]:return None
            facts=self.original['manifest']['orderFacts'].get(oid,{})
            from .estimate_model import number
            if number(facts.get('cashProjection',{}).get('exactStoredDecimalNet'))!=row['cash_delta']:return None
        except (ValueError,TypeError,BaselineError):return None
        return row

    def known_fee(self,row,proposed):
        return row['source'] in ('owner_recorded','broker_reported') or row['id'] in self.actual or row['id'] in proposed

    def scoped_orders(self,currency=None,record_id=None):
        result=[]
        for row in self.orders_by_record.get(record_id,[]) if record_id is not None else self.source_orders:
            link=self.links.get(value(row,'id'));record=self.records.get(value(row,'record_id'))
            if value(link,'account_id')!=self.source_account:
                if value(link,'account_id') is None and value(record,'broker_account_id')==self.source_account:raise ValueError('original_cash_attribution_unknown')
                continue
            if currency is not None:
                if value(link,'currency') is None:raise ValueError('source_cash_currency_unknown')
                if value(link,'currency')!=currency:continue
            if record_id is not None and value(row,'record_id')!=record_id:continue
            result.append(row)
        return result

    def record_known(self,record):
        if not self.valid:return False
        source_ids=self.target_sources.get(record,set())
        if not source_ids:return True
        if len(source_ids)!=1:return False
        try:
            source_id=next(iter(source_ids));orders=self.scoped_orders(record_id=source_id)
            matched=[self.matched_trade(row) for row in orders]
            if not orders or any(row is None or row['record_id']!=record for row in matched) or len({row['id'] for row in matched})!=len(matched):return False
            latest=max(matched,key=lambda row:row['before_record_revision']);original_record=self.records.get(source_id)
            if exact(original_record,'qty')!=latest['after_quantity'] or exact(original_record,'cost')!=latest['after_cost']:return False
            ids={row['id'] for row in matched}
            return all(row['id'] in ids or row['created_at']>self.cutoff and row['source'] in ('owner_recorded','broker_reported') for row in self.trades_by_record.get(record,[]))
        except (ValueError,TypeError,ArithmeticError,BaselineError):return False

    def records_known(self,currency=None):
        if not self.valid:return False
        record_ids={value(row,'id') for row in self.tables['records'] if value(row,'broker_account_id')==self.source_account}
        if currency is not None:
            record_ids={value(row,'record_id') for row in self.scoped_orders(currency=currency)}
        for original_id in record_ids:
            targets=self.record_targets.get(original_id,set())
            if len(targets)!=1 or not self.record_known(next(iter(targets))):return False
        return True

    def currency_known(self,currency,proposed=()):
        if not self.valid:return False
        try:
            matched=set();trade_ids=set();trades=self.scoped_orders(currency=currency)
            for old in trades:
                row=self.matched_trade(old)
                if not row or row['id'] in trade_ids or not self.known_fee(row,proposed):return False
                trade_ids.add(row['id']);matched.add(row['cash_entry_id'])
            cash_by_request=self.cash_by_request;cash_by_id=self.cash_by_id
            for old in self.source_cash:
                if value(old,'currency') is None:return False
                if value(old,'currency')!=currency:continue
                fund=value(old,'fund_id')
                if fund and (fund.startswith('fund-order-') or self.fund_counts[fund]!=1):return False
                source_id='fund:'+fund if fund else 'broker-entry:'+value(old,'id')
                target=cash_by_request.get(uuid(value(old,'operation_id'))) or cash_by_id.get(self.imported.get(('cash',source_id)))
                if not target or target['id'] in matched or target['kind']!=value(old,'kind') or target['currency']!=currency or at(old,'occurred_at')!=target['occurred_at']:return False
                direction=exact(old,'direction')
                if direction not in (-1,1) or (exact(old,'amount') if direction==1 else exact(old,'amount').copy_negate())!=target['amount']:return False
                if target['kind']=='opening':
                    configs=self.source_openings.get(currency,[])
                    if len(configs)!=1 or value(configs[0],'opening_basis')!='new_external_opening' or exact(configs[0],'opening_amount')!=exact(old,'amount') or at(configs[0],'opening_at')!=target['occurred_at']:return False
                if fund:
                    funds=self.funds_by_id.get(fund,[])
                    if len(funds)!=1 or value(funds[0],'currency')!=currency or exact(funds[0],'amount')!=exact(old,'amount') or exact(funds[0],'direction')!=direction or {'opening':'opening','deposit':'external_deposit','withdrawal':'external_withdrawal','adjustment':'reconcile_balance'}.get(value(funds[0],'type'))!=target['kind'] or at(funds[0],'occurred_at')!=target['occurred_at']:return False
                elif exact(old,'amount')!=0 or target['kind']!='opening':return False
                matched.add(target['id'])
            # Every opening must have original physical evidence; a settings
            # number alone is never fabricated into an opening cash row.
            if any(row['kind']=='opening' and row['currency']==currency and row['id'] not in matched for row in self.cash):return False
            for row in self.cash:
                if row['currency']!=currency or row['id'] in matched:continue
                if row['kind']=='fee_correction' and row['fee_repair_request_id'] in self.actual_requests:continue
                if row['kind']=='trade_correction' and row['trade_amendment_id'] in self.amendment_ids:continue
                if row['created_at']>self.cutoff and row['kind']=='external_deposit':continue
                if row['created_at']>self.cutoff and row['kind'] in ('external_withdrawal','reconcile_balance'):
                    receipt=row.get('independent_cash_result') or {}
                    if receipt.get('state')=='completed' and receipt.get('entryId')==str(row['id']) and receipt.get('currency')==currency and Decimal(receipt.get('delta'))==row['amount']:continue
                trade=self.trades_by_cash.get(row['id'])
                if trade and trade['created_at']>self.cutoff and trade['source'] in ('owner_recorded','broker_reported'):continue
                return False
            return True
        except (ValueError,TypeError,ArithmeticError,BaselineError):return False


async def registered_account_known(conn,owner,account,currency=None,*,proposed=()):
    context=await RegisteredCoverage.load(conn,owner,account)
    if context is None:return True
    with localcontext() as precision:
        precision.prec=80
        if currency is not None:return context.currency_known(currency,proposed)
        return context.valid and all(context.currency_known(currency,proposed) for currency in context.account['currencies'])


async def registered_record_known(conn,owner,record):
    row=await(await conn.execute('SELECT account_id FROM legacy_fee_baseline_bindings WHERE owner_id=%s AND record_id=%s LIMIT 1',(owner,record))).fetchone()
    if not row:return True
    context=await RegisteredCoverage.load(conn,owner,row['account_id'])
    return context is not None and context.record_known(record)
