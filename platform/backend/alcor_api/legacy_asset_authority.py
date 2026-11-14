"""Owner-declared valuation units, independent from immutable financial identity."""

from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_metadata import BrokerMetadata, fingerprint
from .legacy_broker_read import iso
from .legacy_broker_statements import request_id
from .native_app_auth import CLIENT, authenticate
from .portfolio_records import PortfolioRecords


class LegacyAssetAuthority(BrokerMetadata):
    def __init__(self, db, market_authority):
        super().__init__(db)
        self.records = PortfolioRecords(db)
        self.market_authority = market_authority

    @asynccontextmanager
    async def context(self, who, *, shared_read=False):
        async with super().context(who, shared_read=shared_read) as conn:
            if getattr(who,'native_client',False):
                current=await authenticate(conn,who.native_access_token,lock=not shared_read,shared=shared_read)
                scopes=getattr(who,'asset_required_scopes',())
                if current['id']!=who.grant_id or current['user_id']!=who.id or current['client_id']!=CLIENT:
                    raise HTTPException(401,'连接已变化')
                if not set(scopes)<=set(current['scope'].split()):
                    raise HTTPException(403,'连接缺少明确授权的范围')
            yield conn

    async def declaration(self, conn, owner, record):
        stored=await (await conn.execute('SELECT v.* FROM asset_instrument_heads h JOIN asset_instrument_versions v ON v.owner_id=h.owner_id AND v.id=h.version_id WHERE h.owner_id=%s AND h.record_id=%s',(owner,record['id']))).fetchone()
        return self.project_declaration(record, stored), stored

    async def declarations(self, conn, owner, records):
        if not records:
            return {}
        rows = await (await conn.execute(
            """SELECT v.*,h.record_id AS head_record_id FROM asset_instrument_heads h
            JOIN asset_instrument_versions v ON v.owner_id=h.owner_id AND v.id=h.version_id
            WHERE h.owner_id=%s AND h.record_id=ANY(%s)""",
            (owner, [record["id"] for record in records]),
        )).fetchall()
        return {row["head_record_id"]: row for row in rows}

    @staticmethod
    def project_declaration(record, stored):
        matches=bool(stored and (stored['market'],stored['code'])==(record['market'],record['code']))
        value={'kind':stored['kind'] if matches else 'unknown','listingStatus':stored['listing_status'] if matches else 'unknown',
               'multiplier':1 if matches and stored['kind']!='unknown' else None,'underlyingRecordId':None,
               'source':'owner_declared' if matches else 'unavailable','revision':stored['revision'] if stored else 0,
               'identityMatches':matches,'updatedAt':iso(stored['created_at']) if stored else None}
        return value

    async def instrument(self, who, record_id):
        async with self.context(who,shared_read=True) as conn:
            record=await self.records.get(conn,who.id,record_id)
            if not record:raise HTTPException(404,'持仓记录不存在')
            declaration,_=await self.declaration(conn,who.id,record)
            return {'recordId':record_id,'recordRevision':record['revision'],'market':record['market'],
                    'code':record['code'],'instrument':declaration}

    async def declare(self, who, record_id, raw):
        if (not isinstance(raw,dict) or set(raw)!={'requestId','recordRevision','revision','kind','listingStatus'}
                or type(raw['recordRevision']) is not int or not 1<=raw['recordRevision']<=9007199254740991
                or type(raw['revision']) is not int or not 0<=raw['revision']<9007199254740991
                or raw['kind'] not in ('cash_equity','etf','unknown') or raw['listingStatus'] not in ('listed','delisted','unknown')):
            raise HTTPException(400,'证券声明参数无效；期权及衍生品尚不支持')
        identifier=UUID(request_id(raw['requestId']))
        expected=fingerprint({'recordId':record_id,'data':raw})
        async with self.context(who) as conn:
            prior=await (await conn.execute('SELECT fingerprint,result FROM asset_instrument_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
            if prior:
                if prior['fingerprint']!=expected:raise HTTPException(409,'requestId 已使用，请查询原回执')
                return prior['result']
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,identifier,'instrument')
            record=await self.records.get(conn,who.id,record_id)
            declaration,previous=await self.declaration(conn,who.id,record) if record else (None,None)
            error=None
            if not record:error={'status':404,'message':'持仓记录不存在','code':40401}
            elif record['revision']!=raw['recordRevision'] or declaration['revision']!=raw['revision']:
                error={'status':409,'message':'记录或证券声明已变化，请重新读取后确认','code':40902}
            value=None
            if error is None:
                version=uuid4()
                await conn.execute('''INSERT INTO asset_instrument_versions(owner_id,record_id,id,request_id,revision,record_revision,market,code,kind,listing_status,previous_id)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (who.id,record_id,version,identifier,raw['revision']+1,record['revision'],record['market'],record['code'],raw['kind'],raw['listingStatus'],previous['id'] if previous else None))
                await conn.execute('INSERT INTO asset_instrument_heads(owner_id,record_id,version_id) VALUES(%s,%s,%s) ON CONFLICT(owner_id,record_id) DO UPDATE SET version_id=excluded.version_id',(who.id,record_id,version))
                current,_=await self.declaration(conn,who.id,record)
                value={'recordId':record_id,'recordRevision':record['revision'],'market':record['market'],'code':record['code'],'instrument':current}
            now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
            result={'requestId':str(identifier),'recordId':record_id,'accountId':who.id,'state':'failed' if error else 'completed',
                    'code':error['code'] if error else 0,'message':error['message'] if error else 'ok','data':value,
                    'completedAt':iso(now),'kind':'instrument_declaration','status':error['status'] if error else 200,
                    'financialIdentityChanged':False}
            await conn.execute('INSERT INTO asset_instrument_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,identifier,expected,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'asset.instrument.declare',%s,%s)",(who.id,record_id,identifier))
            return result

    async def receipt(self,who,request):
        async with self.context(who,shared_read=True) as conn:
            result=await (await conn.execute('SELECT result FROM asset_instrument_operations WHERE owner_id=%s AND request_id=%s',(who.id,UUID(str(request))))).fetchone()
            if not result:raise HTTPException(404,'未找到已提交回执')
            return result['result']

    async def snapshot(self,who,options=None):
        from .legacy_asset_snapshot import snapshot
        return await snapshot(self,who,options or {})
