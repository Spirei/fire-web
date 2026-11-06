"""Legacy coverage is an input to ordinary financial reads and funding checks.

An independent known currency scope remains available. A partial source never
makes the canonical owner/global view look complete. New platform users have no
legacy head and keep normal behavior. Revocation does not invalidate history.
"""
import json
from uuid import uuid4
from fastapi import HTTPException
from .scope_derivation import ScopeDerivation,domain,intersects,stable_view
from .source_snapshot import canonical,sha
from .financial_families import family_coverage


def account_signatures(manifest,financial):
    if financial is None or not manifest['coverage']['complete']:return {}
    accounts={r['sourceAccountId'] for r in [*financial['cash'],*financial['orders']] if r['sourceAccountId'] is not None}
    result={}
    for account in accounts:
        orders=[r for r in financial['orders'] if r['sourceAccountId']==account]
        cash=[r for r in financial['cash'] if r['sourceAccountId']==account]
        records=[r for r in financial['records'] if r['originalBrokerAccountId']==account]
        checkpoints=[{'accountKind':s['accountKind'],'currency':s['currency'],'amount':a['amount']} for s in financial['cashScopes'] for a in s['accounts'] if a['sourceAccountId']==account]
        if any(r['amount'] is None for r in cash) or any(c['amount'] is None for c in checkpoints):continue
        if any(r['status']=='filled' and (r['fees'] is None or r['feeAuthority'] not in ('owner_recorded','broker_reported')) for r in orders):continue
        if any(r[p][k] is None for r in records for p in ('opening','closing') for k in ('quantity','cost')):continue
        content={'orders':orders,'cash':cash,'records':records,'checkpoints':checkpoints}
        result[account]={'hash':sha(canonical(stable_view(content))),'recordIds':{r['id'] for r in records}}
    return result


async def status(conn,owner):
    async with conn.transaction():return await _status(conn,owner)


async def _status(conn,owner):
    original=await(await conn.execute('SELECT m.* FROM legacy_source_heads h JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id WHERE h.owner_id=%s',(owner,))).fetchone()
    if not original:return {'complete':True,'sourcePresent':False,'scopes':[]}
    financial=json.loads(bytes(original['financial_raw'])) if original['financial_raw'] else None
    current=ScopeDerivation(original['manifest'],financial).inventory()
    account_proofs=account_signatures(original['manifest'],financial);known_accounts=set();known_records=set();matched_sources=set()
    items={item['scope']:{'scope':item['scope'],'sourceKnown':item['ready'],'complete':False,'blockers':item['blockers'],'semanticSha256':item.get('semanticSha256'),'accountIds':[],'recordIds':[]} for item in current}
    # A receipt can close only its actual registered manifest within this exact
    # predecessor lineage; a self-uploaded/unbound source never satisfies this.
    wanted={scope for scope,item in items.items() if item['sourceKnown']}
    if wanted or account_proofs:
        async with conn.cursor(name='legacy_coverage_'+uuid4().hex) as cursor:
            await cursor.execute('''WITH RECURSIVE chain AS (
               SELECT m.* FROM legacy_source_manifests m WHERE m.owner_id=%s AND m.id=%s
               UNION ALL SELECT m.* FROM legacy_source_manifests m JOIN chain c ON c.owner_id=m.owner_id AND c.predecessor_hash=m.manifest_sha256
              ) SELECT s.id source_id,m.manifest,m.financial_raw,o.request_id FROM chain m
              JOIN financial_import_sources s ON s.owner_id=m.owner_id AND s.source_manifest_id=m.id
              JOIN financial_import_operations o ON o.owner_id=s.owner_id AND o.result->>'sourceId'=s.id::text
              WHERE o.result->>'financialApplied'='true' AND o.result->>'state'='completed'
                AND m.manifest->'normalizationBlockers'='[]'::jsonb ORDER BY o.created_at DESC''',(owner,original['id']))
            while prior:=await cursor.fetchone():
                if not prior['financial_raw']:continue
                historical_financial=json.loads(bytes(prior['financial_raw']))
                historical=ScopeDerivation(prior['manifest'],historical_financial).inventory()
                old_accounts=account_signatures(prior['manifest'],historical_financial)
                for account,old in old_accounts.items():
                    if account not in account_proofs or account_proofs[account]['hash']!=old['hash']:continue
                    matched_sources.add(account)
                    links=await(await conn.execute("SELECT l.object_kind,l.original_id,l.original,l.target_id,legacy_mapping_target_snapshot(l.owner_id,l.object_kind,l.target_id) target FROM financial_import_links l WHERE l.owner_id=%s AND l.source_id=%s AND (l.object_kind='record' AND l.original_id=ANY(%s) OR l.object_kind IN ('cash','order') AND l.original->>'sourceAccountId'=%s)",(owner,prior['source_id'],list(old['recordIds']),account))).fetchall()
                    for link in links:
                        if not link['target']:continue
                        if link['object_kind']=='record':
                            known_records.add(link['target_id']);target_account=link['target'].get('broker_account_id')
                        else:target_account=link['target'].get('account_id')
                        if target_account:known_accounts.add(target_account)
                for old in historical:
                    now=items.get(old['scope'])
                    if not now or not old['ready'] or not now['sourceKnown'] or now['semanticSha256']!=old.get('semanticSha256'):continue
                    ids=old['originalIds']['record'];accounts=set();records=set()
                    links=await(await conn.execute("SELECT l.target_id,legacy_mapping_target_snapshot(l.owner_id,l.object_kind,l.target_id) target FROM financial_import_links l WHERE l.owner_id=%s AND l.source_id=%s AND l.object_kind='record' AND l.original_id=ANY(%s)",(owner,prior['source_id'],ids))).fetchall()
                    for link in links:
                        if link['target']:
                            records.add(link['target_id']);account=link['target'].get('broker_account_id')
                            if account:accounts.add(account)
                    now.update(complete=True,closedByRequestId=str(prior['request_id']),accountIds=sorted(accounts),recordIds=sorted(records))
                if all(items[scope]['complete'] for scope in wanted) and set(account_proofs)<=matched_sources:break
    families=family_coverage()
    recorded=original['manifest']['coverage'].get('financialFamilies')
    if isinstance(recorded,dict) and recorded.get('schemaEvidenceKnown') is True and {item.get('family') for item in recorded.get('unresolvedFamilies',[])}=={item['family'] for item in families['unresolvedFamilies']} and all(item.get('state')=='unknown' and item.get('amount') is None for item in recorded['unresolvedFamilies']):families=recorded
    return {'complete':False,'brokerScopesComplete':bool(items) and all(item['complete'] for item in items.values()),'wholeLegacyFinancialComplete':False,'coverageScope':families['scope'],'unresolvedFamilies':families['unresolvedFamilies'],'sourcePresent':True,'manifestId':str(original['id']),'manifestSha256':original['manifest_sha256'],'scopes':list(items.values()),'knownAccountIds':sorted(known_accounts),'knownRecordIds':sorted(known_records)}


def limited(detail):
    raise HTTPException(409,'原账还有未核对范围，请按已核对账户查看；完整总额暂不可用',headers={'X-Alcor-Financial-Scope':'incomplete'})


async def require_global(conn,owner):
    state=await status(conn,owner)
    if not state['complete']:limited(state)
    return state


async def scope_status(conn,owner,kind,currency):
    state=await status(conn,owner);wanted=domain(kind,currency)
    if state['complete']:return True
    if state.get('unresolvedFamilies'):return False
    relevant=[item for item in state['scopes'] if intersects(wanted,item['scope'])]
    return all(item['complete'] for item in relevant)


async def require_scope(conn,owner,kind,currency):
    if not await scope_status(conn,owner,kind,currency):limited({'scope':domain(kind,currency),'complete':False})


async def record_status(conn,owner,record):
    from .registered_account_coverage import registered_record_known
    if not await registered_record_known(conn,owner,record):return False
    state=await status(conn,owner)
    if state['complete']:return True
    known=set(state.get('knownRecordIds',[]))|{rid for item in state['scopes'] if item['complete'] for rid in item['recordIds']}
    if record in known:return True
    # A platform manual record is its own identity. Do not infer it belongs to an
    # unknown legacy order merely because its symbol or broker name happens to match.
    imported=await(await conn.execute("SELECT 1 FROM financial_import_links WHERE owner_id=%s AND object_kind='record' AND target_id=%s",(owner,record))).fetchone()
    return not imported


async def require_record(conn,owner,record):
    if not await record_status(conn,owner,record):limited({'recordId':record,'complete':False})


async def account_status(conn,owner,account,currency=None):
    from .registered_account_coverage import RegisteredCoverage
    registered=await RegisteredCoverage.load(conn,owner,account)
    if registered is not None:return registered.currency_known(currency) if currency is not None else registered.records_known()
    state=await status(conn,owner)
    if state['complete']:return True
    if account in state.get('knownAccountIds',[]) or any(item['complete'] and account in item['accountIds'] for item in state['scopes']):return True
    imported=await(await conn.execute("SELECT 1 FROM financial_import_links l JOIN portfolio_records r ON r.owner_id=l.owner_id AND r.id=l.target_id WHERE l.owner_id=%s AND l.object_kind='record' AND r.broker_account_id=%s",(owner,account))).fetchone()
    return not imported
