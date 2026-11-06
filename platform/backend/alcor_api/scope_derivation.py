"""Derive auditable independent financial scopes from one sealed source view.

This module never reads a source, writes a balance, or accepts uploaded authority.
The raw whole-source snapshot remains authoritative and visible, including gaps.
"""
import copy
from collections import defaultdict

from fastapi import HTTPException
from alcor_api.financial_source import parse_source
from alcor_api.financial_continuation import semantics
from .source_snapshot import canonical,sha

KINDS=('real','simulated')
CURRENCIES={'US':'USD','HK':'HKD','CN':'CNY','SG':'SGD','JP':'JPY','KR':'KRW','UK':'GBP'}
ORDER_TABLES={'trade_orders','trade_fee_details','trade_fee_evidence','trade_fee_corrections','trade_fee_detail_history','trade_correction_originals','trade_correction_replacements','app_asset_order_versions','app_trade_metadata','broker_cash_order_links'}
GLOBAL_CODES={'source_persistent_dataset_identity_not_verified','source_table_coverage_incomplete','source_iana_timezone_missing','source_owner_not_verified','source_primary_identity_missing','source_primary_identity_duplicate','legacy_migration_temporary_tables_require_authority_resolution','source_prefix_conflict','financial_view_contract_cannot_represent_original_scope'}


def domain(kind,currency):
    return (kind if kind in KINDS else 'unknown')+':'+(currency or 'unknown')


def intersects(a,b):
    ak,ac=a.split(':');bk,bc=b.split(':')
    return (ak=='unknown' or bk=='unknown' or ak==bk) and (ac=='unknown' or bc=='unknown' or ac==bc)


def evidence_ids(value):
    if isinstance(value,dict):
        result={v for k,v in value.items() if k in ('evidenceId','feeEvidenceId') and isinstance(v,str)}
        for v in value.values():result|=evidence_ids(v)
        return result
    if isinstance(value,list):
        result=set()
        for v in value:result|=evidence_ids(v)
        return result
    return set()


def stable_view(value):
    """A newer source snapshot can retain the exact same independent scope."""
    value=semantics(value)
    if isinstance(value,dict):
        value={k:stable_view(v) for k,v in value.items() if k not in ('evidence','version','source')}
    elif isinstance(value,list):value=[stable_view(v) for v in value]
    return value


class ScopeDerivation:
    def __init__(self,manifest,financial):
        self.manifest=manifest;self.financial=financial
        self.orders={};self.cash={};self.records={};self.accounts=defaultdict(set);self.raw_refs=defaultdict(set)
        self.domains=set();self.row_domains={}
        if financial is None:return
        for item in financial['cashScopes']:self.domains.add(domain(item['accountKind'],item['currency']))
        for item in financial['orders']:
            d=domain(item['accountKind'],item['settlementCurrency']);self.orders[item['id']]={d};self.domains.add(d)
            self.records.setdefault(item['recordId'],set()).add(d)
            if item['sourceAccountId']:self.accounts[item['sourceAccountId']].add(d)
        for item in financial['cash']:
            d=domain(item['accountKind'],item['currency']);self.cash[item['id']]={d};self.domains.add(d)
            if item['sourceAccountId']:self.accounts[item['sourceAccountId']].add(d)
        for item in financial['records']:
            if item['id'] not in self.records:
                currency='CNY' if item['market']=='HK' and item['accountMarket']=='CN' else CURRENCIES.get(item['market'])
                self.records[item['id']]={domain(item['accountKind'],currency)}
                self.domains|=self.records[item['id']]
        for item in manifest.get('lineage',[]):
            if 'normalizedCashId' in item:
                for key in item['sourceIds']:
                    if key:self.raw_refs[(item['sourceTable'],key)]|=self.cash.get(item['normalizedCashId'],set())
            elif 'excludedFundId' in item:
                self.raw_refs[('fund_transactions',item['excludedFundId'])]|=self.orders.get(item.get('orderId'),{'unknown:unknown'})

    def blocker_domains(self,item):
        code=item['code'];table=item.get('table');key=item.get('originalId')
        if code in GLOBAL_CODES or not table or key is None:return {'unknown:unknown'}
        if table in ORDER_TABLES:return self.orders.get(key,{'unknown:unknown'})
        if table in ('records','record_revisions'):return self.records.get(key,{'unknown:unknown'})
        if table=='broker_accounts':return self.accounts.get(key,{'unknown:unknown'})
        return self.raw_refs.get((table,key),{'unknown:unknown'})

    def select(self,scope):
        if scope not in self.domains or scope.split(':')[0] not in KINDS or scope.endswith(':unknown'):
            return {'scope':scope,'ready':False,'blockers':[{'code':'source_scope_unknown_or_absent'}],'financial':None}
        blockers=[]
        if not self.manifest['coverage']['complete']:blockers.append({'code':'raw_source_coverage_incomplete'})
        for item in self.manifest['normalizationBlockers']:
            if any(intersects(scope,other) for other in self.blocker_domains(item)):blockers.append(copy.deepcopy(item))
        # An unknown original domain can overlap the chosen scope. It must not be
        # discarded merely because the caller supplied a currency/account filter.
        for other in self.domains:
            if other!=scope and intersects(scope,other):blockers.append({'code':'unresolved_source_scope_overlaps_selected_scope','scope':other})
        source=copy.deepcopy(self.financial)
        source['orders']=[r for r in source['orders'] if self.orders[r['id']]=={scope}]
        record_ids={r['id'] for r in source['records'] if self.records[r['id']]=={scope}}
        for order in source['orders']:
            if order['recordId'] not in record_ids:blockers.append({'code':'record_spans_unresolved_source_domains','originalId':order['recordId']})
        source['records']=[r for r in source['records'] if r['id'] in record_ids]
        source['cash']=[r for r in source['cash'] if self.cash[r['id']]=={scope}]
        source['cashScopes']=[r for r in source['cashScopes'] if domain(r['accountKind'],r['currency'])==scope]
        if len(source['cashScopes'])!=1:blockers.append({'code':'selected_cash_scope_checkpoint_missing_or_duplicated'})
        for checkpoint in source['cashScopes']:
            if not checkpoint['complete'] or checkpoint['ownerTotal'] is None or checkpoint['unallocated'] is None or any(a['amount'] is None for a in checkpoint['accounts']):
                blockers.append({'code':'selected_cash_scope_checkpoint_unknown'})
        for item in source['cash']:
            if item['amount'] is None or item['occurredAt'] is None:blockers.append({'code':'selected_original_cash_unknown','originalId':item['id']})
        for item in source['orders']:
            if item['status']=='filled' and (item['fees'] is None or item['feeAuthority'] not in ('owner_recorded','broker_reported')):
                blockers.append({'code':'selected_actual_fee_unknown','originalId':item['id']})
        for item in source['records']:
            if any(item[point][field] is None for point in ('opening','closing') for field in ('quantity','cost')):
                blockers.append({'code':'selected_position_checkpoint_unknown','originalId':item['id']})

        wanted=evidence_ids([source['records'],source['orders'],source['cash'],source['cashScopes']])
        source['evidence']=[r for r in source['evidence'] if r['id'] in wanted]
        source['source']['version']=self.manifest['rawSha256']+':scope:'+scope
        source['source']['complete']=not blockers
        try:parse_source(canonical(source))
        except HTTPException:blockers.append({'code':'scope_view_cannot_represent_originals'})
        ids={kind:[r['id'] for r in source[key]] for kind,key in (('record','records'),('order','orders'),('cash','cash'))}
        semantic=sha(canonical(stable_view(source)))
        return {'scope':scope,'ready':not blockers,'blockers':blockers,'financial':source,'semanticSha256':semantic,'originalIds':ids}

    def inventory(self):
        if self.financial is None:return [{'scope':'unknown:unknown','ready':False,'blockers':[{'code':'parent_normalized_source_view_unavailable'}],'financial':None}]
        return [self.select(scope) for scope in sorted(self.domains)]
