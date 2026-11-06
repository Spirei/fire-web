"""Old cash DTO/CAS bridge; all posting rules remain in CashLedger."""

import re
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from fastapi import HTTPException

from .broker_accounts import broker_account
from .broker_metadata import fingerprint
from .cash_ledger import CashLedger
from .cash_overview import CashOverview
from .legacy_broker_read import account_view, iso
from .legacy_broker_statements import request_id
from .legacy_cash_read import activity_facts, money, snapshot_dto

HASH=re.compile(r'[a-f0-9]{64}',re.ASCII)


def amount(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)):
        raise HTTPException(400,'金额无效')
    result=Decimal(str(value))
    if not result.is_finite() or abs(result)>Decimal('1e12') or result.as_tuple().exponent < -8:
        raise HTTPException(400,'金额无效')
    return result


def text(value):
    if not isinstance(value,str) or len(value.encode('utf-16-le',errors='surrogatepass'))//2>200 or '\x00' in value:
        raise HTTPException(400,'备注无效')
    return value


def when(value):
    try:
        at=datetime.fromisoformat(value)
        if at.tzinfo is None or at>datetime.now(UTC):raise ValueError()
    except (AttributeError,ValueError,TypeError):raise HTTPException(400,'时间无效') from None
    return at.astimezone(UTC).isoformat()


def integer(value,minimum=0):
    return type(value) is int and minimum<=value<=9007199254740991


def global_dto(owner,overview,now):
    books=[book for book in overview['books'] if book['currencies']]
    separated=len(books)>1
    currencies=sorted({row['currency'] for book in books for row in book['currencies']})
    rows=[]
    for currency in currencies:
        parts=[row for book in books for row in book['currencies'] if row['currency']==currency]
        known=not separated and len(parts)==1 and parts[0]['complete']
        row=parts[0]
        rows.append({'currency':currency,'totalCash':money(row['ownerBalance']) if known else None,
            'cardCash':None,'brokerCash':money(row['registeredAttributedBalance']) if known else None,
            'unallocatedCash':money(row['unallocatedBalance']) if known else None,'complete':known,
            'unavailableReasons':['card_cash_relationship_not_registered']+(['account_kinds_separated'] if separated else [] if known else ['owner_cash_opening_or_source_unknown'])})
    return {'userId':owner,'globalCashRevision':overview['snapshotRevision'],'asOf':iso(now),
        'complete':bool(rows) and all(row['complete'] for row in rows),'byCurrency':rows,
        'migration':{'books':overview['books'],'coverageScope':overview['coverageScope'],
                     'historicalCoverageKnown':False,'accountKindsSeparated':separated}}


async def overview_on_connection(conn,who,service,*,include_accounts=False,version=2):
    value=await CashOverview(service.db).on_connection(conn,who)
    now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
    result=global_dto(who.id,value,now)
    if include_accounts:
        if len(value['accounts'])>100:raise HTTPException(409,'账户数量超过总览上限，请先核对账户目录')
        instance=str((await (await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone())['instance_id'])
        accounts=[]
        for entry in value['accounts']:
            account=await broker_account(conn,who.id,entry['accountId'])
            dto=await account_view(conn,who.id,account['id'],[],version=version)
            facts=await activity_facts(conn,who.id,account,entry['snapshot'])
            cash=snapshot_dto(who.id,account,entry['snapshot'],facts,instance=instance,observed_at=now)
            cash['globalCashRevision']=result['globalCashRevision']
            accounts.append({'account':dto,'cash':cash})
        head=(await (await conn.execute('SELECT revision FROM broker_account_collections WHERE owner_id=%s',(who.id,))).fetchone())
        result.update({'version':1,'accounts':accounts,'accountCollectionRevision':head['revision'] if head else 0,
                       'accountsComplete':True,'cashComplete':result['complete']})
    result['snapshotRevision']=fingerprint({key:item for key,item in result.items() if key!='asOf'})
    return result,value


class LegacyCashCommands:
    def __init__(self,authority):
        self.authority=authority
        self.db=authority.db
        self.cash=CashLedger(self.db)

    async def overview(self,who,include_accounts=False,version=2):
        async with self.authority.context(who) as conn:
            result,_=await overview_on_connection(conn,who,self,include_accounts=include_accounts,version=version)
            return result

    async def receipt(self,who,identifier):
        result=await self.cash.receipt(who,identifier)
        return result.get('legacySnapshot',result)

    async def command(self,who,raw,*,submit=False,owner_target=False):
        if not isinstance(raw,dict):raise HTTPException(400,'现金参数无效')
        rid=request_id(raw.get('requestId'))
        expected=fingerprint({'ownerTarget':owner_target,'body':raw})
        if owner_target:
            allowed={'requestId','accountId','snapshotRevision','currency','balance','note'}
            if set(raw)-allowed or not allowed-{'note'}<=set(raw) or raw['accountId']!=who.id or not isinstance(raw['snapshotRevision'],str) or not HASH.fullmatch(raw['snapshotRevision']):
                raise HTTPException(400,'现金核对参数无效')
            value=amount(raw['balance']);note=text(raw.get('note',''))
        else:
            required={'requestId','action','currency','amount','occurredAt','globalCashRevision','brokerAccountId','targets'}
            if set(raw)-(required|{'note','openingBasis','previewRevision'}) or not required<=set(raw) or not isinstance(raw['globalCashRevision'],str) or not HASH.fullmatch(raw['globalCashRevision']):
                raise HTTPException(400,'现金参数无效')
            if not isinstance(raw['brokerAccountId'],str) or not re.fullmatch(r'ba-[a-f0-9]{24}',raw['brokerAccountId'],re.ASCII):raise HTTPException(400,'目标账户无效')
            value=amount(raw['amount']);note=text(raw.get('note',''))
            occurred=when(raw['occurredAt'])
            if raw['action'] not in ('opening','external_deposit','external_withdrawal','reconcile_balance') or value<0 or value==0 and raw['action'] in ('external_deposit','external_withdrawal'):
                raise HTTPException(400,'现金操作或金额无效')
            if raw['action']=='opening' and raw.get('openingBasis') not in ('new_external_opening','allocate_verified_unallocated_checkpoint') or raw['action']!='opening' and 'openingBasis' in raw:
                raise HTTPException(400,'现金期初依据无效')
        currency=raw.get('currency')
        from .legacy_broker_read import LEGACY_CURRENCIES
        if currency not in LEGACY_CURRENCIES:raise HTTPException(400,'币种无效')
        async with self.authority.context(who) as conn:
            await self.cash.lock(conn,who)
            prior=await (await conn.execute('SELECT result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                result=prior['result']
                if result.get('state')=='closed':return result
                if result.get('legacyRequestHash')!=expected:raise HTTPException(409,'原UUID已用于其他操作，请查询原回执')
                return result['legacySnapshot']
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,rid,'cash')
            overview=await CashOverview(self.db).on_connection(conn,who)
            now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
            if owner_target:
                before_dto=await self.owner_snapshot(conn,who,overview,now)
                if raw['snapshotRevision']!=before_dto['snapshotRevision']:raise HTTPException(409,'现金快照已变化，请重新核对')
                matches=[(book,row) for book in overview['books'] for row in book['currencies'] if row['currency']==currency and row['openingKnown']]
                if len(matches)!=1 or not matches[0][1]['complete'] or matches[0][1]['ownerBalance'] is None or matches[0][1]['registeredAttributedBalance'] is None:
                    raise HTTPException(409,'现金归属或期初尚未明确')
                book,row=matches[0]
                with localcontext() as context:
                    context.prec=80
                    unallocated=value-Decimal(row['registeredAttributedBalance'])
                if unallocated<0:raise HTTPException(409,'总余额小于已归属账户现金，不能隐式改变账户账本')
                canonical={'requestId':rid,'accountId':None,'accountKind':book['accountKind'],'currency':currency,
                    'action':'reconcile_balance','amount':str(unallocated),'occurredAt':iso(now),'note':note,
                    'evidence':{'reference':'owner-total-request:'+rid+':target='+str(value),'observedAt':iso(now)}}
                before=Decimal(row['ownerBalance'])
            else:
                if raw['globalCashRevision']!=overview['snapshotRevision']:raise HTTPException(409,'全局现金版本已变化，请重新核对')
                account=await broker_account(conn,who.id,raw['brokerAccountId'])
                targets=raw['targets']
                if (not isinstance(targets,list) or len(targets)!=1 or not isinstance(targets[0],dict) or set(targets[0])!={'brokerAccountId','brokerRevision','cashRevision'}
                        or targets[0]['brokerAccountId']!=account['id'] or not integer(targets[0]['brokerRevision'],1) or not integer(targets[0]['cashRevision'])):
                    raise HTTPException(400,'目标账户版本无效')
                if targets[0]['brokerRevision']!=account['revision']:raise HTTPException(409,'账户已变化')
                entry=next((item for item in overview['accounts'] if item['accountId']==account['id']),None)
                cashrow=next((item for item in entry['snapshot']['currencies'] if item['currency']==currency),None) if entry else None
                cash_revision=entry['snapshot']['revision'] if cashrow and cashrow['opening'] is not None else 0
                if targets[0]['cashRevision']!=cash_revision:raise HTTPException(409,'账户现金版本已变化')
                canonical={'requestId':rid,'accountId':account['id'],'accountKind':account['account_kind'],'currency':currency,
                    'action':raw['action'],'amount':str(value),'occurredAt':occurred,'note':note}
                if 'openingBasis' in raw:canonical['openingBasis']=raw['openingBasis']
            proof=await self.cash.preview(who,canonical,connection=conn)
            preview={'userId':who.id,'action':canonical['action'],'currency':currency,'amount':money(value),
                'occurredAt':canonical['occurredAt'],'globalCashRevision':overview['snapshotRevision'],
                'targets':raw.get('targets',[]),'effects':[{'kind':'unallocated' if owner_target else 'broker','id':canonical['accountId'] or who.id,
                    'currency':currency,'before':money(proof['balanceBefore']),'after':money(proof['balanceAfter']),
                    'delta':money(proof['delta']),'cashRevision':proof['revision']}],
                'globalEffect':money(proof['delta']) if proof['affectsOwnerCash'] else 0,
                'externalFlow':money(proof['delta']) if canonical['action'] in ('external_deposit','external_withdrawal') else 0,
                'canSubmit':True,'migration':{'accountKind':canonical['accountKind'],'authority':'platform_posted_cash_ledger'}}
            preview['previewRevision']=fingerprint(preview)
            if not submit:return preview
            if not owner_target and raw.get('previewRevision')!=preview['previewRevision']:raise HTTPException(409,'预览已变化，请重新核对')
            async def project(connection,result):
                after=await CashOverview(self.db).on_connection(connection,who)
                if owner_target:
                    snapshot=await self.owner_snapshot(connection,who,after,now)
                    data={**snapshot,'currency':currency,'before':money(before),'after':money(value),'adjustment':money(value-before)}
                    kind='reconcile_cash'
                else:
                    data={'operationId':str(result['entryId']),**preview,'globalCashRevision':after['snapshotRevision'],'snapshots':[]}
                    account_result,_=await overview_on_connection(connection,who,self,include_accounts=True)
                    data['snapshots']=[item['cash'] for item in account_result['accounts'] if item['account']['id']==canonical['accountId']]
                    kind='cash_'+canonical['action']
                dto={'requestId':rid,'accountId':who.id,'kind':kind,'state':'completed','code':0,'message':'ok','data':data,'completedAt':iso(now)}
                return {'legacyRequestHash':expected,'legacySnapshot':dto}
            result=await self.cash._submit_ledger(who,canonical,proof['preview'],connection=conn,project=project)
            return result.get('legacySnapshot',result)

    async def owner_snapshot(self,conn,who,overview,now):
        result=global_dto(who.id,overview,now)
        return {'accountId':who.id,'snapshotRevision':overview['snapshotRevision'],'asOf':iso(now),
            'balances':{row['currency']:row['totalCash'] for row in result['byCurrency']},
            'nativeBalancesByCurrency':{row['currency']:row['totalCash'] for row in result['byCurrency']} if result['complete'] else None,
            'balancesByCurrency':{row['currency']:row['totalCash'] for row in result['byCurrency']} if result['complete'] else None,
            'source':'recorded_cash_ledger','valuationIndependent':True,
            'missingOpeningCurrencies':[row['currency'] for row in result['byCurrency'] if not row['complete']],
            'sourceComplete':result['complete'],'complete':result['complete'],'unavailableReasons':sorted({reason for row in result['byCurrency'] for reason in row['unavailableReasons']}),
            'marketAllocationAvailable':False,'migration':result['migration']}
