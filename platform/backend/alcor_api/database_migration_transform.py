"""Deterministic conversion of sealed PG row sidecars; never posts live financial data."""
import json
import hashlib
import re
from collections import Counter
from decimal import Decimal
from pathlib import PurePosixPath

from .backups import BackupFailure,private_read
from .database_migration_capture import canonical,file_sha,sha
from .source_snapshot import TABLES,pg_cell
from .source_mapping import Mapping
from .financial_families import structure_evidence,captured_family_evidence

# Only pg_dump's explicit built-in column types are recognized. Unknown types
# remain unverified; a JSON number alone never proves an exact PG NUMERIC.
COLUMN=re.compile(r'^    ("(?:[^"]|"")*"|[a-z_][a-z0-9_]*) (numeric(?:\(\d+(?:,\d+)?\))?|bigint|integer|smallint|text|boolean|real|double precision|character varying(?:\(\d+\))?|timestamp(?:\(\d+\))? with(?:out)? time zone|uuid|jsonb?|bytea)(?= |,|$)')
CREATE=re.compile(r'^CREATE TABLE ("(?:[^"]|"")*"|[a-z_][a-z0-9_]*)\.("(?:[^"]|"")*"|[a-z_][a-z0-9_]*) \($')
def unquote(value):return value[1:-1].replace('""','"') if value.startswith('"') else value

def columns_from_dump(raw):
    result={};selected=None
    for line in raw.decode('utf-8').splitlines():
        start=CREATE.fullmatch(line)
        if start:selected=tuple(unquote(v) for v in start.groups());result[selected]={};continue
        if selected and line==');':selected=None;continue
        if selected:
            column=COLUMN.match(line)
            if column:
                name,kind=column.groups();kind=re.sub(r'\(.*?\)','',kind)
                result[selected][unquote(name)]=kind
    return result


class FrozenTables:
    def __init__(self,root,manifest,cancel,budget):
        self.root=root;self.manifest=manifest;self.cancel=cancel;self.budget=budget
        self.inventory={(t['schema'],t['name']):t for t in manifest['tables']}
        self.columns=columns_from_dump(private_read(root/'schema.sql',16*1024**2));self.cache={}
        if file_sha(root/'schema.sql',cancel)!=manifest['schema_sha256']:raise BackupFailure('来源结构归档已变化')
    def rows(self,schema,name):
        key=(schema,name)
        if key in self.cache:return self.cache[key]
        table=self.inventory.get(key)
        if not table:self.cache[key]=[];return []
        relative=PurePosixPath(table['file'])
        if len(relative.parts)!=2 or relative.parts[0]!='rows' or not re.fullmatch(r'[a-f0-9]{64}\.jsonl',relative.parts[1]):raise BackupFailure('来源副本路径无效')
        path=self.root/relative
        if file_sha(path,self.cancel)!=table['file_sha256']:raise BackupFailure('来源逐表副本已变化')
        if path.stat().st_size>64*1024**2:raise BackupFailure('来源表超过本次转换预算，需要分段')
        rows=[];observed=hashlib.sha256()
        with path.open('rb') as source:
            for raw in source:
                self.budget.check(self.root,self.cancel);observed.update(raw)
                if len(raw)>16*1024**2:raise BackupFailure('来源行超过转换预算')
                try:row=json.loads(raw,parse_float=Decimal,parse_int=Decimal)
                except (ValueError,RecursionError):raise BackupFailure('来源副本内容无效') from None
                if not isinstance(row,dict):raise BackupFailure('来源副本行无效')
                if len(rows)>=100000:raise BackupFailure('来源表超过本次转换条数预算')
                rows.append(row)
        if observed.hexdigest()!=table['file_sha256']:raise BackupFailure('来源副本在转换期间发生变化')
        if len(rows)!=table['rows']:raise BackupFailure('来源副本数量已变化')
        self.cache[key]=rows;return rows


def choose_account(market,label,original_id,*,accounts,labels,markets,names,override=None):
    if override:return (override,False) if override in accounts else (None,True)
    market_choice=markets.get(str(market));label_choice=labels.get(str(label or ''))
    if market_choice and label_choice and market_choice!=label_choice:return None,True
    candidates=names.get(str(label or ''),[])
    key=market_choice or label_choice or original_id or (candidates[0] if len(candidates)==1 else None)
    return (key,False) if key in accounts else (None,False)


def storage_snapshot(tables,owner,timezone):
    manifest=tables.manifest;schema=manifest['selected_schema'];converted={};unknown=[]
    orders=tables.rows(schema,'trade_orders');order_ids={str(r['id']) for r in orders if str(r.get('user_id'))==owner}
    for name,(allowed,scope) in TABLES.items():
        types=tables.columns.get((schema,name),{});selected=allowed.split();rows=[]
        unknown.extend(name+'.'+key for key in types if key not in selected and key not in ('_alcor_rowid','icon'))
        for row in tables.rows(schema,name):
            if (str(row.get('user_id'))==owner if scope=='user_id' else str(row.get('order_id')) in order_ids):
                cells={}
                for key in selected:
                    if key not in types:continue
                    value=row.get(key)
                    text=None if value is None else str(value) if isinstance(value,(str,Decimal)) else 'true' if value is True else 'false' if value is False else json.dumps(value,separators=(',',':'),ensure_ascii=False,default=str)
                    cells[key]=pg_cell(text,types[key])
                rows.append(cells)
        converted[name]={'present':(schema,name) in tables.inventory,'columns':[{'name':key,'type':kind} for key,kind in types.items()],'rows':rows}
    families=structure_evidence({name:[{'name':key,'type':kind} for key,kind in columns.items()] for (ns,name),columns in tables.columns.items() if ns==schema},method='sealed_pg_dump_schema_and_rows')
    identity=manifest['identity']
    return {'format':'legacy-storage-snapshot/1','source':{'alias':'prepared-pg-snapshot','instance':sha(canonical({key:identity[key] for key in ('system_identifier','oid','database')})),
        'kind':'postgres','owner':owner,'ownerVerified':any(str(r.get('id'))==owner for r in tables.rows(schema,'users')),
        'datasetIdentityVerified':True,'schemaHash':sha(private_read(tables.root/'schema.sql',16*1024**2)),
        'snapshotToken':manifest['snapshot'],'timezone':timezone,'unknownColumns':unknown,
        'unresolvedMigrationTables':[name for ns,name in tables.inventory if ns==schema and name in ('trade_orders_new','fund_transactions_new')],
        'financialFamilyEvidence':captured_family_evidence(families,converted)},'tables':converted}


def transform(tables,*,source_owner,account_kinds,broker_labels=None,market_accounts=None,order_accounts=None,timezone,publish):
    broker_labels=broker_labels or {};market_accounts=market_accounts or {};order_accounts=order_accounts or {}
    schema=tables.manifest['selected_schema'];users=tables.rows(schema,'users')
    if not any(str(row.get('id'))==source_owner for row in users):raise BackupFailure('所选来源账号不在本次快照内')
    accounts=[row for row in tables.rows(schema,'broker_accounts') if str(row.get('user_id'))==source_owner]
    ids={str(row['id']) for row in accounts}
    if set(account_kinds)-ids or set(broker_labels.values())-ids or set(market_accounts.values())-ids or set(order_accounts.values())-ids:raise BackupFailure('账户分类包含其他来源账号')
    if any(value not in ('real','simulated') for value in account_kinds.values()):raise BackupFailure('账户分类无效')
    raw=storage_snapshot(tables,source_owner,timezone)
    # Confirmed classifications are a separate conversion assertion. Original raw
    # cells remain unchanged and every assertion is included in the plan hash.
    import copy
    normalized=copy.deepcopy(raw)
    for row in normalized['tables']['broker_accounts']['rows']:
        key=row['id']['text']
        if key in account_kinds:row['account_kind']=pg_cell(account_kinds[key],'text')
    publish({'phase':'conversion_financial','processed':0,'total':len(normalized['tables']['trade_orders']['rows']),'unit':'orders'})
    mapped=Mapping(normalized).build()
    issues=mapped['manifest']['normalizationBlockers'];counts=Counter(item['code'] for item in issues)
    # No-history watchlist entries do not require a financial position opening.
    watch_ids={r['id']['text'] for r in normalized['tables']['records']['rows'] if (r.get('qty',{}).get('null') or Decimal(r['qty']['text'])==0) and r['id']['text'] not in {o['record_id']['text'] for o in normalized['tables']['trade_orders']['rows']}}
    issues=[item for item in issues if not(item['table']=='records' and item['originalId'] in watch_ids and item['code'] in ('no_independent_position_opening','original_input_missing','original_real_simulated_identity_unknown'))]
    orders=[r for r in tables.rows(schema,'trade_orders') if str(r.get('user_id'))==source_owner]
    if set(order_accounts)-{str(row['id']) for row in orders}:raise BackupFailure('逐笔映射包含其他来源订单')
    records=[r for r in tables.rows(schema,'records') if str(r.get('user_id'))==source_owner]
    funds=[r for r in tables.rows(schema,'fund_transactions') if str(r.get('user_id'))==source_owner]
    auto=[r for r in funds if str(r.get('id','')).startswith('fund-order-')]
    registered_brokers={}
    for row in accounts:registered_brokers.setdefault(str(row.get('name','')),[]).append(str(row['id']))
    by_account={str(row['id']):row for row in accounts};original_orders={str(row['id']):row for row in orders}
    resolved_orders={};resolved_records={};extra=[]
    def selected(market,label,original_id=None,override=None):
        return choose_account(market,label,original_id,accounts=by_account,labels=broker_labels,markets=market_accounts,names=registered_brokers,override=override)
    for row in records:
        key,_conflict=selected(row.get('market'),None,str(row.get('broker_account_id') or ''))
        if key:resolved_records[str(row['id'])]=key
    for row in orders:
        key,conflict=selected(row.get('market'),row.get('broker'),override=order_accounts.get(str(row['id'])))
        if key:resolved_orders[str(row['id'])]=key
        if conflict:extra.append({'code':'account_mapping_conflict','table':'trade_orders','originalId':str(row['id']),'field':'broker'})
    financial=mapped['financial']
    if financial:
        for order in financial['orders']:
            key=resolved_orders.get(order['id']);old=original_orders[order['id']]
            if key:
                order.update(sourceAccountId=key,originalBrokerAccountId=str(old.get('broker') or '') or None,accountKind=account_kinds.get(key) or by_account[key].get('account_kind') or 'unknown')
            if old.get('market')=='HK' and market_accounts.get('HK') and key==market_accounts['HK'] and order['id'] not in order_accounts:
                # Owner declared the account, not an actual settlement amount.
                if old.get('settlement_currency')!='CNY' or old.get('settlement_amount') is None:
                    extra.append({'code':'connect_actual_cny_settlement_missing','table':'trade_orders','originalId':order['id'],'field':'settlement_amount'})
        by_order={order['id']:order for order in financial['orders']}
        for record in financial['records']:
            key=resolved_records.get(record['id'])
            if key:record['accountKind']=account_kinds.get(key) or by_account[key].get('account_kind') or 'unknown'
            if record['market']=='HK' and market_accounts.get('HK') and not any(original_orders[oid].get('record_id')==record['id'] and account!=market_accounts['HK'] for oid,account in order_accounts.items()):record['accountMarket']='CN'
        financial['records']=[record for record in financial['records'] if record['id'] not in watch_ids]
        for cash in financial['cash']:
            order=by_order.get(cash['orderId'])
            if order:
                cash.update(sourceAccountId=order['sourceAccountId'],originalBrokerAccountId=order['originalBrokerAccountId'],accountKind=order['accountKind'],originalScope='broker' if order['sourceAccountId'] else 'unallocated')
        # Original cash scopes are retained as unverified source projections;
        # attribution does not turn them into independently verified balances.
        financial['cashScopes']=[{**scope,'complete':False} for scope in financial['cashScopes']]
    issues=[item for item in issues if not (
        item['code'] in ('original_unallocated_order_needs_verified_attribution','original_order_real_simulated_identity_unknown') and item['originalId'] in resolved_orders
        or item['code']=='original_real_simulated_identity_unknown' and item['originalId'] in account_kinds
    )]+extra
    counts=Counter(item['code'] for item in issues)
    named=len(resolved_orders)
    publish({'phase':'conversion_financial','processed':len(orders),'total':len(orders),'unit':'orders'})
    available=lambda name,value:value if (schema,name) in tables.inventory else None
    domains=[{'key':'identity','label':'账号与安全','source':sum(str(row.get('id'))==source_owner for row in users),'state':'requires_cutover','converted':0},
        {'key':'accounts','label':'券商账户','source':available('broker_accounts',len(accounts)),'converted':sum(str(row['id']) in account_kinds or row.get('account_kind') in ('real','simulated') for row in accounts),'state':'analyzed'},
        {'key':'positions','label':'持仓与自选','source':available('records',len(records)),'converted':len(records),'holdings':sum(row.get('qty') is not None and row['qty']>0 for row in records),'state':'normalized'},
        {'key':'orders','label':'历史交易','source':available('trade_orders',len(orders)),'converted':len(financial['orders']) if financial else 0,'named_broker_rows':named,'missing_broker_rows':sum(not row.get('broker') for row in orders),'state':'needs_confirmation' if issues else 'normalized'},
        {'key':'cash','label':'资金流水','source':available('fund_transactions',len(funds)),'converted':len(funds)-len(auto),'excluded_trade_projections':len(auto),'state':'needs_confirmation'},
        {'key':'pnl','label':'历史盈亏','source':available('trade_orders',sum(r.get('status')=='filled' and r.get('side') in ('sell','dividend') for r in orders)),'converted':sum(r.get('status')=='filled' and r.get('side') in ('sell','dividend') and r.get('realized_pnl') is not None for r in orders),'state':'retained_not_recalculated'},
        {'key':'assets','label':'素材与原件','source':available('assets',sum(t['rows'] for (ns,name),t in tables.inventory.items() if ns==schema and name=='assets')),'converted':0,'state':'requires_file_verification'}]
    for domain in domains:
        if domain['source'] is None:domain['state']='unknown'
    for index,domain in enumerate(domains,1):publish({'phase':'conversion_domains','processed':index,'total':len(domains),'unit':'domains'})
    def portable(value):
        if isinstance(value,Decimal):return str(value)
        if isinstance(value,dict):return {key:portable(item) for key,item in value.items()}
        if isinstance(value,list):return [portable(item) for item in value]
        return value
    groups=[row for row in tables.rows(schema,'watch_groups') if str(row.get('user_id'))==source_owner]
    record_accounts={}
    for row in records:
        if row.get('qty') is not None and row['qty']>0:
            account=resolved_records.get(str(row['id']))
            if account:record_accounts[str(row['id'])]=account
    group_ids={str(row['id']) for row in groups};portfolio_issues=[]
    for row in records:
        if row.get('qty') is not None and row['qty']>0 and str(row['id']) not in record_accounts:portfolio_issues.append('holding_account_unresolved')
        if row.get('watch_group_id') and str(row['watch_group_id']) not in group_ids:portfolio_issues.append('watch_group_missing')
    for row in accounts:
        if (account_kinds.get(str(row['id'])) or row.get('account_kind')) not in ('real','simulated'):portfolio_issues.append('account_kind_unresolved')
        if row.get('holding_source')!='manual':portfolio_issues.append('official_account_requires_own_import')
    portfolio={'accounts':portable(accounts),'records':portable(records),'groups':portable(groups),'record_accounts':record_accounts,
        'ready':bool(records) and not portfolio_issues,'issues':sorted(set(portfolio_issues)),
        'source_tables':[{key:table[key] for key in ('schema','name','rows','multiset_sha256')} for (ns,name),table in tables.inventory.items() if ns==schema and name in ('broker_accounts','records','watch_groups')],
        'source_instance':raw['source']['instance'],'source_owner':source_owner,'source_schema':schema}
    plan={'format':'database-migration-conversion/1','source_manifest_sha256':sha(private_read(tables.root/'manifest.json',16*1024**2)),
        'source_owner':source_owner,'account_classifications':account_kinds,'timezone':timezone,'domains':domains,
        'issues':issues,'issue_counts':dict(counts),'financial':financial,'raw_snapshot':raw,'broker_labels':broker_labels,'market_accounts':market_accounts,'order_accounts':order_accounts,'fee_policy':'retain_unverified',
        'portfolio':portfolio,'raw_rewritten':False,'business_written':False,'cutover_ready':False,
        'table_inventory':[{'schema':ns,'name':name,'rows':table['rows'],'sha256':table['file_sha256']} for (ns,name),table in sorted(tables.inventory.items())]}
    return plan
