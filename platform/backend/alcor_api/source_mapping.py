"""One manifest, with financial and fee views of the same read-only source.

Stored input and source-read-model projections remain distinct from broker reports.
Never guesses a decimal from SQLite REAL, an original broker from current records,
an opening from today's balance, or an actual fee from a default zero.
"""
import base64
import json
import math
import re
from datetime import datetime
from decimal import Decimal,InvalidOperation,localcontext
from uuid import UUID

from .source_snapshot import TABLES,canonical,sha
from .financial_families import family_coverage

CURRENCY={'US':'USD','HK':'HKD','CN':'CNY','JP':'JPY','KR':'KRW','SG':'SGD','EU':'EUR','UK':'GBP'}
MODEL_VERSION='legacy-cash-structure-exact-decimal/1'
def legacy_settlement_currency(market):
    # Exact old funds.ts fallback is retained as a SOURCE projection; a mismatch
    # with a canonical market blocks import instead of silently fixing history.
    for names,currency in ((('HK','HKG'),'HKD'),(('CN','SH','SZ','A'),'CNY'),(('JP','JPN'),'JPY'),(('KR','KOR'),'KRW'),(('SG','SGP'),'SGD'),(('EU','EUR'),'EUR')):
        if market in names:return currency
    return 'USD'
def fee_bytes(value):
    # Exact compatibility with the sole FeeSourceInventory fingerprint contract.
    return json.dumps(value,sort_keys=True,separators=(',',':'),default=str).encode()


class Mapping:
    def __init__(self,snapshot):
        self.raw=snapshot;self.raw_bytes=canonical(snapshot);self.raw_hash=sha(self.raw_bytes)
        self.owner=snapshot['source']['owner'];self.blockers=[];self.documents=[];self.lineage=[];self.facts={}
        self.rows={name:table['rows'] for name,table in snapshot['tables'].items()}
        self._indexes={};self._groups={};self._document_ids=set();self._blocker_ids=set()

    def block(self,code,table=None,key=None,field=None):
        value={'code':code,'table':table,'originalId':key,'field':field}
        identity=(code,table,key,field)
        if identity not in self._blocker_ids:self._blocker_ids.add(identity);self.blockers.append(value)

    def value(self,row,field):
        cell=(row or {}).get(field)
        if not cell or cell.get('null'):return None
        return cell.get('text')

    def exact(self,row,field,table,key,*,required=True):
        cell=(row or {}).get(field)
        if not cell or cell.get('null'):
            if required:self.block('original_input_missing',table,key,field)
            return None
        if cell.get('storedDecimalExact') is not True and cell.get('storageType') not in ('text','character varying','character','integer','bigint','smallint'):
            self.block('stored_binary_number_not_original_decimal',table,key,field);return None
        try:
            value=Decimal(cell['text'])
            if not value.is_finite():raise InvalidOperation
            return value
        except (InvalidOperation,ValueError,KeyError):self.block('stored_number_invalid',table,key,field);return None

    def evidence(self,table,row,key,kind,*,projection=None):
        content={'representation':'logical_frozen_source_row','sourceRawSha256':self.raw_hash,'table':table,'originalId':key,'row':row}
        if projection:content.update(representation='existing_legacy_read_model_projection',projection=projection,physicalCashRow=False)
        raw=canonical(content);identifier='e-'+sha(raw)+'-'+kind
        if identifier not in self._document_ids:
            self._document_ids.add(identifier);self.documents.append({'id':identifier,'kind':kind,'sha256':sha(raw),'rawBase64':base64.b64encode(raw).decode()})
        return identifier

    def rows_by(self,table,key):
        identity=(table,key)
        if identity not in self._indexes:self._indexes[identity]={self.value(row,key):row for row in self.rows[table]}
        return self._indexes[identity]

    def rows_grouped(self,table,key):
        identity=(table,key)
        if identity not in self._groups:
            groups={}
            for row in self.rows[table]:groups.setdefault(self.value(row,key),[]).append(row)
            self._groups[identity]=groups
        return self._groups[identity]

    def revision(self,row,field,table,key):
        value=self.exact(row,field,table,key)
        if value is None or value<1 or value!=value.to_integral_value():self.block('original_revision_unknown',table,key,field);return 'unknown'
        return format(value.to_integral_value(),'f')

    def aware(self,row,field,table,key):
        value=self.value(row,field)
        try:
            if value is None or datetime.fromisoformat(value).tzinfo is None:raise ValueError
        except ValueError:self.block('original_timezone_or_instant_unknown',table,key,field)
        return value

    def fee(self,order,oid,listing):
        registered=self.exact(order,'fees','trade_orders',oid)
        details=self.rows_by('trade_fee_details','order_id').get(oid)
        evidence=self.rows_by('trade_fee_evidence','order_id').get(oid)
        authority='unverified_legacy';document=None
        if details:
            try:
                original_input=json.loads(self.value(details,'input_json'),parse_float=Decimal)
                detail=json.loads(self.value(details,'detail_json'),parse_float=Decimal)
            except (TypeError,ValueError):self.block('fee_snapshot_json_invalid','trade_fee_details',oid);original_input={};detail={}
            if not isinstance(original_input,dict) or not isinstance(detail,dict):self.block('fee_snapshot_json_invalid','trade_fee_details',oid);original_input={};detail={}
            try:total=Decimal(str(detail.get('total')))
            except InvalidOperation:total=None
            fee_account=original_input.get('brokerAccountId');account=self.rows_by('broker_accounts','id').get(fee_account) if isinstance(fee_account,str) else None
            original_link=self.rows_by('broker_cash_order_links','order_id').get(oid)
            bound_account=bool(account and detail.get('brokerAccountId')==fee_account and original_input.get('providerId')==self.value(account,'provider_id') and detail.get('providerId')==self.value(account,'provider_id') and (not original_link or self.value(original_link,'account_id')==fee_account))
            if original_input.get('source')=='owner_recorded' and original_input.get('confirmed') is True and detail.get('source')=='owner_recorded' and detail.get('currency')==listing and registered is not None and total==registered and bound_account:
                authority='owner_recorded';document=self.evidence('trade_fee_details',details,oid,'confirmed_fee')
            elif original_input.get('source')=='rule_calculated':self.block('recorded_rule_fee_requires_estimate_authority_model','trade_fee_details',oid)
            else:self.block('fee_snapshot_authority_mismatch','trade_fee_details',oid)
        elif evidence and self.value(evidence,'source') in ('explicit_order_entry','explicit_fee_confirmation') and registered is not None:
            authority='owner_recorded';document=self.evidence('trade_fee_evidence',evidence,oid,'confirmed_fee')
        else:self.block('actual_fee_authority_unknown','trade_orders',oid,'fees')
        declared=self.value(evidence,'source')
        if details:
            try:declared=json.loads(self.value(details,'detail_json')).get('source')
            except (ValueError,TypeError):pass
        self.facts[oid]={'registeredFee':None if registered is None else str(registered),'registeredFeeCell':order.get('fees'),'sourceDeclaredAuthority':declared,'actualFeeAuthority':authority,'actualFeeKnown':authority=='owner_recorded','feeEvidenceId':document}
        return registered,registered if authority=='owner_recorded' else None,authority,document

    def build(self):
        with localcontext() as context:
            context.prec=80
            return self._build()

    def validate_positions(self):
        from alcor_api.trade_accounting import AccountingError,FilledTrade,Position,apply_filled_trade
        for rid,record in self.rows_by('records','id').items():
            history=[row for row in self.rows_grouped('trade_orders','record_id').get(rid,[]) if self.value(row,'status')=='filled']
            history.sort(key=lambda row:(self.value(row,'traded_at') or '',self.value(row,'created_at') or ''))
            times=[(self.value(row,'traded_at'),self.value(row,'created_at')) for row in history]
            if len(times)!=len(set(times)):self.block('original_fill_causal_order_unproved','records',rid);continue
            position=None
            for row in history:
                oid=self.value(row,'id')
                before_qty=self.exact(row,'position_qty_before','trade_orders',oid)
                before_cost=self.exact(row,'position_cost_before','trade_orders',oid,required=False)
                qty=self.exact(row,'qty','trade_orders',oid);price=self.exact(row,'price','trade_orders',oid);amount=self.exact(row,'amount','trade_orders',oid);fees=self.exact(row,'fees','trade_orders',oid)
                after_qty=self.exact(row,'position_qty_after','trade_orders',oid);after_cost=self.exact(row,'position_cost_after','trade_orders',oid,required=False)
                if any(v is None for v in (before_qty,qty,price,amount,fees,after_qty)):continue
                if position is not None and (position.quantity!=before_qty or position.cost!=before_cost):self.block('original_position_prefix_inconsistent','trade_orders',oid)
                try:
                    side=self.value(row,'side');market=self.value(row,'market');currency=CURRENCY.get(market)
                    if not currency:continue
                    if side=='dividend':qty=Decimal(0);price=Decimal(0)
                    explicit_cny=self.value(row,'settlement_currency')=='CNY'
                    settlement='CNY' if explicit_cny else legacy_settlement_currency(market)
                    trade=FilledTrade(side,qty,price,fees,amount,currency,settlement,self.exact(row,'settlement_amount','trade_orders',oid,required=explicit_cny))
                    result=apply_filled_trade(Position(before_qty,before_cost),trade)
                    if result.position.quantity!=after_qty or result.position.cost!=after_cost:self.block('original_registered_position_projection_differs','trade_orders',oid)
                    # Preserve the original stored state even when it differs; do
                    # not silently rewrite it to the new engine's projection.
                    position=Position(after_qty,after_cost)
                except AccountingError:self.block('original_fill_values_not_reconcilable','trade_orders',oid)
            if history and position is not None:
                current_qty=self.exact(record,'qty','records',rid);current_cost=self.exact(record,'cost','records',rid,required=False)
                if current_qty!=position.quantity or current_cost!=position.cost:self.block('source_current_position_differs_from_original_history','records',rid)

    def _build(self):
        self.validate_positions()
        source=self.raw['source'];coverage={'scope':'legacy_portfolio_trade_and_fund_cash_tables','complete':all(t['present'] for name,t in self.raw['tables'].items() if name not in ('account_financing_policy','account_financing_requests')) and not any(not field.startswith(('account_financing_policy.','account_financing_requests.')) for field in source['unknownColumns']) and source['ownerVerified'] and source['datasetIdentityVerified'] and not source['unresolvedMigrationTables'],'tables':{k:{'present':t['present'],'rows':len(t['rows'])} for k,t in self.raw['tables'].items()},'unknownColumns':source['unknownColumns'],'owner':self.owner,'ownerVerified':source['ownerVerified'],'datasetIdentityVerified':source['datasetIdentityVerified'],'unresolvedMigrationTables':source['unresolvedMigrationTables']}
        coverage['financialFamilies']=family_coverage(source.get('financialFamilyEvidence'))
        coverage['wholeLegacyFinancialComplete']=False
        if not source['ownerVerified']:self.block('source_owner_identity_not_verified')
        if not source['datasetIdentityVerified']:self.block('source_persistent_dataset_identity_not_verified')
        if source['unresolvedMigrationTables']:self.block('legacy_migration_temporary_tables_require_authority_resolution')
        for table,rows in self.rows.items():
            keys=('user_id',) if table=='account_financing_policy' else ('user_id','account_id','currency') if table=='broker_cash_accounts' else ('user_id','record_id') if table=='record_revisions' else ('user_id','request_id') if table in ('app_asset_operations','trade_correction_operations','account_financing_requests') else ('id',) if table in ('records','broker_accounts','fund_transactions','broker_cash_entries','trade_orders','trade_fee_detail_history') else ('order_id',)
            identities=[tuple(self.value(row,key) for key in keys) for row in rows]
            if any(any(v is None for v in key) for key in identities):self.block('source_primary_identity_missing',table)
            if len(identities)!=len(set(identities)):self.block('source_primary_identity_duplicate',table)
        if not coverage['complete']:self.block('source_table_coverage_incomplete')
        if not source['timezone']:self.block('source_iana_timezone_missing')
        for name in ('trade_fee_corrections','trade_correction_originals','trade_correction_replacements'):
            if self.rows[name]:self.block('original_correction_chain_requires_append_only_mapping',name)
        accounts=self.rows_by('broker_accounts','id');record_rows=self.rows_by('records','id');versions=self.rows_by('app_asset_order_versions','order_id');record_versions=self.rows_by('record_revisions','record_id')
        links=self.rows_by('broker_cash_order_links','order_id');metadata=self.rows_by('app_trade_metadata','order_id')
        openings={(self.value(r,'account_id'),self.value(r,'currency')):r for r in self.rows['broker_cash_accounts']}
        funds=self.rows_by('fund_transactions','id');fund_entries={};cash=[];orders=[];fee_orders=[];records=[];registered_deltas={};source_accounts=set();owner_totals={};broker_totals={};scopes=set();unsafe=False
        def kind_for(account_id,record=None):
            row=accounts.get(account_id)
            value=self.value(row,'account_kind')
            if value not in ('real','simulated'):self.block('original_real_simulated_identity_unknown','broker_accounts',account_id);return 'unknown'
            if self.value(row,'holding_source')!='manual':self.block('official_source_requires_official_import_path','broker_accounts',account_id)
            return value
        def add_cash(item,raw_table,raw_ids,representation):
            cash.append(item);self.lineage.append({'normalizedCashId':item['id'],'sourceTable':raw_table,'sourceIds':raw_ids,'representation':representation,'physicalCashRow':representation=='source_cash_row','sourceOwner':self.owner})
            scope=(item['accountKind'],item['currency']);scopes.add(scope);amount=Decimal(item['amount']) if item['amount'] is not None else None
            previous=owner_totals.get(scope,Decimal(0));owner_totals[scope]=None if previous is None or item['affectsOwner'] and amount is None else previous+(amount if item['affectsOwner'] else Decimal(0))
            if item['sourceAccountId']:
                k=(*scope,item['sourceAccountId']);previous=broker_totals.get(k,Decimal(0));broker_totals[k]=None if previous is None or amount is None else previous+amount
        for row in self.rows['broker_cash_entries']:
            key=self.value(row,'id');fund_id=self.value(row,'fund_id')
            if fund_id:
                if fund_id in fund_entries:self.block('fund_posting_linked_twice','broker_cash_entries',key)
                fund_entries[fund_id]=row
                if fund_id not in funds or fund_id.startswith('fund-order-'):self.block('broker_fund_reference_not_independent_manual_cash','broker_cash_entries',key,'fund_id')
        order_requests={}
        for row in self.rows['app_asset_operations']:
            try:receipt=json.loads(self.value(row,'result_json'))
            except (ValueError,TypeError):self.block('original_operation_json_invalid','app_asset_operations',self.value(row,'request_id'));continue
            if receipt.get('state')=='completed' and receipt.get('kind')=='submit_trade':
                items=(receipt.get('data') or {}).get('items',[])
                if len(items)==1 and isinstance(items[0],dict) and self.uuid(self.value(row,'request_id')):
                    oid=items[0].get('id')
                    if oid in order_requests:self.block('multiple_original_submission_receipts','trade_orders',oid)
                    order_requests[oid]=self.uuid(self.value(row,'request_id'))
                elif items:self.block('source_operation_multiple_orders_needs_lineage_mapping','app_asset_operations',self.value(row,'request_id'))
        for row in self.rows['fund_transactions']:
            fid=self.value(row,'id');currency=self.value(row,'currency')
            if fid.startswith('card-link-'):self.block('card_cash_link_requires_card_ledger_scope','fund_transactions',fid)
            if not currency or not re.fullmatch('[A-Z]{3}',currency):self.block('original_currency_unknown','fund_transactions',fid);unsafe=True;continue
            if fid.startswith('fund-order-'):
                self.lineage.append({'excludedFundId':fid,'reason':'readFundBalances_excludes_auto_fund_order_rows','orderId':fid[len('fund-order-'):],'sourceOwner':self.owner})
                continue
            entry=fund_entries.get(fid);account_id=self.value(entry,'account_id') if entry else None
            # Unassigned global cash has no real/simulated discriminator in old fund rows.
            # A verified linked broker supplies it; otherwise every old account in this
            # currency must agree, and the explicit source receipt confirms the scope.
            account_kind=kind_for(account_id) if account_id else 'unknown'
            if not account_id:self.block('unallocated_fund_real_simulated_scope_unknown','fund_transactions',fid)
            amount=self.exact(row,'amount','fund_transactions',fid);direction=self.exact(row,'direction','fund_transactions',fid)
            net=None if amount is None or direction not in (Decimal(-1),Decimal(1)) else amount*direction
            action={'opening':'opening','deposit':'external_deposit','withdrawal':'external_withdrawal','adjustment':'reconcile_balance'}.get(self.value(row,'type'))
            if not action:self.block('original_fund_kind_unknown','fund_transactions',fid);unsafe=True;continue
            when=self.aware(row,'occurred_at','fund_transactions',fid)
            if entry:
                eid=self.value(entry,'id');entry_amount=self.exact(entry,'amount','broker_cash_entries',eid);entry_direction=self.exact(entry,'direction','broker_cash_entries',eid)
                if self.value(entry,'currency')!=currency or self.value(entry,'occurred_at')!=when or entry_amount!=amount or entry_direction!=direction or self.value(entry,'kind')!=action:self.block('fund_broker_cash_link_mismatch','broker_cash_entries',eid)
                if action=='opening':
                    opening=openings.get((account_id,currency))
                    if not opening or self.value(opening,'opening_basis')!='new_external_opening' or self.value(opening,'opening_at')!=when or self.exact(opening,'opening_amount','broker_cash_accounts',account_id)!=amount:self.block('original_external_broker_opening_mismatch','broker_cash_entries',eid)
                key='fund:'+fid;original_broker=account_id;proof=self.evidence('broker_cash_entries',entry,eid,'cash_opening' if action=='opening' else 'cash_posting',projection={'pairedFundId':fid,'countsOwnerOnce':True})
            else:
                key='fund:'+fid;original_broker=None;proof=self.evidence('fund_transactions',row,fid,'cash_opening' if action=='opening' else 'cash_posting')
                if action!='opening':self.block('unallocated_nonopening_cash_requires_verified_attribution','fund_transactions',fid)
            add_cash({'id':key,'version':'snapshot:'+self.raw_hash,'sourceOwner':self.owner,'requestId':self.uuid(self.value(entry,'operation_id')),'sourceAccountId':account_id,'originalBrokerAccountId':original_broker,'originalScope':'broker' if account_id else 'unallocated','accountKind':account_kind,'currency':currency,'kind':action,'amount':None if net is None else str(net),'affectsOwner':True,'occurredAt':when,'orderId':None,'evidenceId':proof},'fund_transactions',[fid,self.value(entry,'id')] if entry else [fid],'linked_fund_and_broker_row' if entry else 'source_cash_row')
        for row in self.rows['broker_cash_entries']:
            if self.value(row,'fund_id'):continue
            key=self.value(row,'id');account_id=self.value(row,'account_id');currency=self.value(row,'currency');opening=openings.get((account_id,currency));amount=self.exact(row,'amount','broker_cash_entries',key);direction=self.exact(row,'direction','broker_cash_entries',key)
            basis=self.value(opening,'opening_basis');allocation=basis=='allocate_verified_unallocated_checkpoint'
            if self.value(row,'kind')!='opening' or not opening or not allocation and amount!=0:self.block('broker_cash_missing_owner_fund_link','broker_cash_entries',key)
            if self.exact(opening,'opening_amount','broker_cash_accounts',account_id)!=amount or self.value(opening,'opening_at')!=self.value(row,'occurred_at') or direction!=1:self.block('original_broker_opening_mismatch','broker_cash_entries',key)
            add_cash({'id':'broker-entry:'+key,'version':str(self.value(opening,'revision') or 'unknown'),'sourceOwner':self.owner,'requestId':self.uuid(self.value(row,'operation_id')),'sourceAccountId':account_id,'originalBrokerAccountId':account_id,'originalScope':'broker','accountKind':kind_for(account_id),'currency':currency,'kind':'allocation' if allocation else 'opening','amount':None if amount is None else str(amount),'affectsOwner':not allocation,'occurredAt':self.aware(row,'occurred_at','broker_cash_entries',key),'orderId':None,'evidenceId':self.evidence('broker_cash_entries',row,key,'explicit_internal_allocation' if allocation else 'cash_opening',projection={'openingBasis':basis,'openingRow':opening,'countsOwner':not allocation})},'broker_cash_entries',[key],'source_cash_row')
        sorted_orders=sorted(self.rows['trade_orders'],key=lambda r:(self.value(r,'traded_at') or '',self.value(r,'created_at') or '',self.value(r,'id') or ''))
        for row in sorted_orders:
            oid=self.value(row,'id');rid=self.value(row,'record_id');record=record_rows.get(rid);link=links.get(oid);account_id=self.value(link,'account_id');account_kind=kind_for(account_id) if account_id else 'unknown'
            if account_id is None:self.block('original_order_real_simulated_identity_unknown','trade_orders',oid)
            market=self.value(row,'market');listing=CURRENCY.get(market);explicit_cny=self.value(row,'settlement_currency')=='CNY';settlement='CNY' if explicit_cny else legacy_settlement_currency(market)
            if listing and settlement!=listing and not (market=='HK' and explicit_cny):self.block('legacy_currency_projection_differs_from_canonical_market','trade_orders',oid)
            if listing is None:self.block('original_market_currency_unknown','trade_orders',oid);unsafe=True
            status=self.value(row,'status');when=self.aware(row,'traded_at','trade_orders',oid);side=self.value(row,'side')
            qty=self.exact(row,'qty','trade_orders',oid);price=self.exact(row,'price','trade_orders',oid);amount=self.exact(row,'amount','trade_orders',oid);registered,actual,fee_authority,fee_proof=self.fee(row,oid,listing)
            settlement_amount=self.exact(row,'settlement_amount','trade_orders',oid,required=explicit_cny)
            # This is the OLD read model, never a newly invented physical cash row.
            gross=amount if amount is not None and amount>0 else qty*price if qty is not None and price is not None else None
            if gross is None:self.block('registered_order_gross_unknown','trade_orders',oid)
            if explicit_cny and (settlement_amount is None or settlement_amount<=0):self.block('original_cny_net_invalid_or_unknown','trade_orders',oid);net=None
            else:net=(-settlement_amount if side=='buy' else settlement_amount) if explicit_cny else None if gross is None or registered is None else -(gross+registered) if side=='buy' else gross-registered
            if explicit_cny and listing=='CNY' and settlement_amount is not None and gross is not None and registered is not None and settlement_amount!=(gross+registered if side=='buy' else gross-registered):self.block('source_registered_cny_net_differs_from_gross_fee','trade_orders',oid)
            legacy_number=None
            if gross is not None and registered is not None:
                try:
                    legacy_number=(-float(settlement_amount) if side=='buy' else float(settlement_amount)) if explicit_cny and settlement_amount is not None else -(float(gross)+float(registered)) if side=='buy' else float(gross)-float(registered)
                    if not math.isfinite(legacy_number):legacy_number=None
                except (OverflowError,ValueError):legacy_number=None
            self.facts[oid]['cashProjection']={'exactStoredDecimalNet':None if net is None else str(net),'legacyNumberRoundTrip':None if legacy_number is None else repr(legacy_number),'legacyNumberBinaryHex':None if legacy_number is None else legacy_number.hex(),'physicalCashRow':False}
            if net is not None and legacy_number is not None and Decimal(repr(legacy_number))!=net:self.block('legacy_number_cash_projection_requires_explicit_reconciliation','trade_orders',oid)
            if self.value(link,'currency') not in (None,settlement):self.block('order_cash_link_currency_mismatch','broker_cash_order_links',oid)
            if status=='filled' and not account_id:self.block('original_unallocated_order_needs_verified_attribution','trade_orders',oid)
            if not record:self.block('original_order_record_orphan','trade_orders',oid)
            version=self.revision(versions.get(oid),'revision','app_asset_order_versions',oid)
            cash_id='order-projection:'+oid if status=='filled' else None
            intent=None
            if status!='filled':
                meta=metadata.get(oid);intent={'orderType':self.value(row,'order_type'),'tif':self.value(row,'tif'),'expiresAt':self.value(row,'expires_at'),'triggerPrice':None if self.exact(row,'trigger_price','trade_orders',oid,required=False) is None else str(self.exact(row,'trigger_price','trade_orders',oid,required=False)),'session':self.value(row,'session'),'triggerStatus':self.value(row,'trigger_status'),'parentId':self.value(meta,'parent_id'),'role':self.value(meta,'role'),'executionContract':self.value(meta,'draft_json')}
            order={'id':oid,'version':version,'sourceOwner':self.owner,'requestId':order_requests.get(oid),'recordId':rid,'sourceAccountId':account_id,'originalBrokerAccountId':account_id,'accountKind':account_kind,'status':status,'fillAuthority':'owner_recorded_history' if status=='filled' else 'not_filled','feeAuthority':fee_authority,'feeEvidenceId':fee_proof,'side':side,'quantity':None if qty is None else str(qty),'price':None if price is None else str(price),'amount':None if amount is None else str(amount),'fees':None if actual is None else str(actual),'currency':listing,'settlementCurrency':settlement,'settlementAmount':None if settlement_amount is None else str(settlement_amount),'occurredAt':when,'cancelledAt':None,'cashId':cash_id,'evidenceId':self.evidence('trade_orders',row,oid,'actual_fill' if status=='filled' else 'order_intent'),'intent':intent}
            if side=='dividend':order.update(quantity='0',price='0')  # original divisor qty/price retained in raw evidence
            if status in ('cancelled','canceled'):self.block('original_cancellation_instant_missing','trade_orders',oid)
            orders.append(order)
            if status=='filled':
                proof=self.evidence('trade_orders',row,oid,'cash_posting',projection={'method':MODEL_VERSION,'grossBasis':'stored_positive_amount_else_stored_qty_times_price','feeBasis':'registered_fee_not_actual_fee_claim','link':link,'excludedAutoFundId':'fund-order-'+oid,'cashNet':None if net is None else str(net)})
                add_cash({'id':cash_id,'version':version,'sourceOwner':self.owner,'requestId':None,'sourceAccountId':account_id,'originalBrokerAccountId':account_id,'originalScope':'broker' if account_id else 'unallocated','accountKind':account_kind,'currency':settlement,'kind':'trade_'+side,'amount':None if net is None else str(net),'affectsOwner':True,'occurredAt':when,'orderId':oid,'evidenceId':proof},'trade_orders',[oid],'existing_legacy_read_model_projection')
            fee_orders.append({'id':oid,'recordId':rid,'status':status,'revision':int(version) if version!='unknown' else None,'recordRevision':None if self.value(record,'revision') is None else int(self.value(record,'revision')),'originalBrokerAccountId':account_id,'brokerAccountId':None,'tradeId':None,'feeAuthority':fee_authority,'cashAttribution':{'scope':'broker' if account_id else 'unallocated','brokerAccountId':account_id,'currency':settlement,'postingId':cash_id,'alreadyReflected':True if status=='filled' else False},'input':{'side':side,'quantity':order['quantity'],'price':order['price'],'amount':order['amount'],'fees':order['fees'],'currency':listing,'settlementCurrency':settlement,'settlementAmount':order['settlementAmount'],'occurredAt':when,'market':market,'code':self.value(row,'code'),'accountKind':account_kind if account_kind!='unknown' else None}})
        for rid,row in record_rows.items():
            history=sorted((r for r in self.rows_grouped('trade_orders','record_id').get(rid,[]) if self.value(r,'status')=='filled'),key=lambda r:(self.value(r,'traded_at') or '',self.value(r,'created_at') or ''));first=history[0] if history else None
            initial_qty=self.exact(first,'position_qty_before','trade_orders',self.value(first,'id')) if first else None;initial_cost=self.exact(first,'position_cost_before','trade_orders',self.value(first,'id'),required=False) if first else None
            if not first:self.block('no_independent_position_opening','records',rid)
            if initial_qty is not None and initial_qty!=0:self.block('verified_nonzero_opening_requires_canonical_opening_support','records',rid)
            if self.value(row,'market')=='HK' and self.value(row,'account_market') is None:self.block('original_account_market_unknown','records',rid,'account_market')
            final_qty=self.exact(row,'qty','records',rid);final_cost=self.exact(row,'cost','records',rid,required=False);account_id=self.value(row,'broker_account_id');kind=kind_for(account_id)
            records.append({'id':rid,'version':self.revision(row,'revision','records',rid),'sourceOwner':self.owner,'code':self.value(row,'code'),'market':self.value(row,'market'),'accountMarket':self.value(row,'account_market') or '','accountKind':kind,'originalBrokerAccountId':account_id,'opening':{'quantity':None if initial_qty is None else str(initial_qty),'cost':None if initial_cost is None else str(initial_cost),'occurredAt':self.value(first,'traded_at'),'evidenceId':self.evidence('trade_orders',first or {},self.value(first,'id') or rid,'position_opening',projection={'basis':'original_stored_position_before','notCurrentRecord':True})},'closing':{'quantity':None if final_qty is None else str(final_qty),'cost':None if final_cost is None else str(final_cost),'evidenceId':self.evidence('records',row,rid,'position_checkpoint')}})
        cash_scopes=[]
        for kind,currency in sorted(scopes,key=str):
            total=owner_totals.get((kind,currency));balances={a:v for (k,c,a),v in broker_totals.items() if k==kind and c==currency}
            if total is not None and total<0 or any(v is not None and v<0 for v in balances.values()):self.block('original_negative_cash_requires_financing_authority',key=currency)
            unallocated=None if total is None or any(v is None for v in balances.values()) else total-sum(balances.values())
            proof=self.evidence('derived_read_model',{'owner':self.owner,'currency':currency},currency,'cash_checkpoint',projection={'method':MODEL_VERSION,'ownerTotal':None if total is None else str(total),'brokerTotals':{k:None if v is None else str(v) for k,v in balances.items()},'unallocated':None if unallocated is None else str(unallocated),'isAssetObservation':False})
            cash_scopes.append({'accountKind':kind,'currency':currency,'complete':coverage['complete'],'ownerTotal':None if total is None else str(total),'unallocated':None if unallocated is None else str(unallocated),'accounts':[{'sourceAccountId':a,'amount':None if v is None else str(v)} for a,v in sorted(balances.items())],'evidenceId':proof})
        cash.sort(key=lambda item:(item['occurredAt'] or '',0 if item['kind']=='opening' else 1 if item['kind']=='allocation' else 2,item['id']))
        financial={'format':'legacy-financial/1','source':{'instance':source['instance'],'owner':self.owner,'version':self.raw_hash,'timezone':source['timezone'],'complete':coverage['complete'],'authority':'frozen_authoritative_export','cashScopeSemantics':'owner_total_includes_allocations'},'evidence':self.documents,'records':records,'cashScopes':cash_scopes,'cash':cash,'orders':orders} if not unsafe else None
        fee={'version':1,'sourceInstance':source['instance'],'sourceOwner':self.owner,'complete':coverage['complete'],'orders':fee_orders} if all(r['revision'] is not None for r in fee_orders) else None
        manifest={'format':'legacy-source-manifest/1','source':{'instance':source['instance'],'owner':self.owner,'kind':source['kind'],'schemaHash':source['schemaHash'],'snapshotToken':source['snapshotToken'],'timezone':source['timezone']},'rawSha256':self.raw_hash,'coverage':coverage,'readModelVersion':MODEL_VERSION,'financialSha256':sha(canonical(financial)) if financial else None,'feeInventorySha256':sha(fee_bytes(fee)) if fee else None,'normalizationBlockers':self.blockers,'lineage':self.lineage,'orderFacts':self.facts,'predecessorHash':None}
        return {'manifest':manifest,'manifestSha256':sha(canonical(manifest)),'raw':self.raw_bytes,'financial':financial,'fee':fee}

    @staticmethod
    def uuid(value):
        try:return str(UUID(value)) if value else None
        except (ValueError,TypeError,AttributeError):return None
