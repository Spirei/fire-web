"""Owner subscription intent over the same PG demands; no source collection in HTTP."""

import re
from dataclasses import asdict
from uuid import UUID, uuid5

from fastapi import HTTPException

from .card_preferences import JS_WHITESPACE
from .market_authority import Authority, active_demands, query_from
from .market_contract import MARKETS, Query, canonical, public_items
from .market_pool_reads import PoolReads
from .market_worker import Bound


def subscription_items(raw,*,remove=False):
    if remove and isinstance(raw,dict) and set(raw)=={"all"} and raw.get("all") is True:return None
    if not isinstance(raw,dict) or set(raw)!={"items"} or not isinstance(raw["items"],list) or not 1<=len(raw["items"])<=100:
        raise HTTPException(400,"请提供 1 至 100 个有效的 market / code")
    for value in raw["items"]:
        if not isinstance(value,dict) or set(value)!={"market","code"} or value.get("market") not in MARKETS or not isinstance(value.get("code"),str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}",value["code"].strip(JS_WHITESPACE)):
            raise HTTPException(400,"请提供 1 至 100 个有效的 market / code")
    items=public_items(raw["items"])
    if not items:raise HTTPException(400,"请提供 1 至 100 个有效的 market / code")
    return sorted(({"market":row["market"],"code":row["code"]} for row in items),key=lambda row:(row["market"],row["code"]))


class Subscriptions:
    def __init__(self,authority):self.authority,self.db=authority,authority.db

    @staticmethod
    def query(item, instrument=None, session=None, policy=None):
        return Query('latest', item['market'], item['code'],
                     instrument=instrument or ('asset' if item['market'] == 'ASSET' else 'equity'),
                     session=(session or 'REGULAR') if item['market']=='US' and (policy is None or policy.source=='futu' or policy.source=='yahoo' and session in ('PRE','AFTER')) else 'REGULAR').validate()

    async def approved_sources(self,conn,who):
        rows=await (await conn.execute("SELECT revision FROM market_source_configs WHERE owner_id=%s ORDER BY revision LIMIT 1001",(who.id,))).fetchall()
        if len(rows)>1000:raise HTTPException(503,'当前来源版本超过核对范围')
        approved=[]
        for row in rows:
            try:_,policy=await self.authority.config(conn,who.id,row['revision'])
            except HTTPException:continue
            approved.append((row['revision'],policy))
        return approved

    async def source(self,conn,who,items,selected,source_preference=None,instrument=None,session=None,*,configs=None):
        if selected is not None:
            _,policy=await self.authority.config(conn,who.id,selected)
            if not {item["market"] for item in items}<=set(policy.markets) or "latest" not in policy.purposes:raise HTTPException(403,"当前来源许可未覆盖此市场")
            for item in items:
                self.authority.validate_query(policy,self.query(item,instrument,session,policy))
            return selected
        approved=[];families={}
        for revision,policy in configs if configs is not None else await self.approved_sources(conn,who):
            if {item["market"] for item in items}<=set(policy.markets) and "latest" in policy.purposes:
                try:
                    for item in items:self.authority.validate_query(policy,self.query(item,instrument,session,policy))
                except (HTTPException,ValueError):continue
                if source_preference in ("futu","tencent")and any(item["market"]!="ASSET"for item in items)and policy.source!=source_preference:continue
                approved.append(revision);families[revision]=policy.source
        if source_preference=="auto"and approved:
            order = getattr(self.db.settings, "_legacy_quote_order", None) or ["futu", "tencent", "eastmoney", "yahoo"]
            # A refused or failed security must not permanently pin an entire
            # market to that provider. Retry the preferred source after 60s;
            # other currently approved sources may serve that security now.
            cooling = set()
            if len(items) == 1:
                item = items[0]
                from .market_source_failures import recent_failed_sources
                cooling = await recent_failed_sources(conn, who.id, approved, item['market'], item['code'], self.query(item,instrument,session).instrument)
            usable = [revision for revision in approved if revision not in cooling] or approved
            for provider in order:
                prioritized = [r for r in usable if families[r] == provider]
                if prioritized:
                    approved = prioritized
                    break
        if not approved:raise HTTPException(503,"本人行情来源尚未配置或未获当前许可")
        if len(approved)!=1:raise HTTPException(409,"存在多个行情来源，请明确选择当前来源版本")
        return approved[0]

    async def mutate(self,who,request_id,items,*,remove=False,selected=None,observe=False,legacy_generated=False,source_preference=None,instrument=None,session=None):
        if instrument not in (None,'equity','index','asset'):
            raise HTTPException(400,'行情证券类型无效')
        if session not in (None,'REGULAR','PRE','AFTER','OVERNIGHT'):raise HTTPException(400,'行情时段无效')
        request_id=UUID(str(request_id));selected=UUID(str(selected)) if selected is not None else None
        operation={"action":"subscriptions.remove" if remove else "subscriptions.observe" if observe else "subscriptions.register","items":items,"sourceRevision":str(selected) if selected else None}
        if instrument is not None:operation['instrument']=instrument
        if session is not None:operation['session']=session
        async with self.db.connection() as conn,conn.transaction():
            await self.authority.owner_lock(conn,who)
            user=await (await conn.execute("SELECT role FROM users WHERE id=%s",(who.id,))).fetchone()
            if not user or user["role"]!=who.role:raise HTTPException(403,"账号权限已变化")
            previous=await self.authority.receipt(conn,who.id,request_id,operation)
            if previous:return previous,True
            # Nested domain operations use this exact PG connection/transaction.
            # Their UUID/CAS/limits/source checks remain the existing implementation.
            bound=Authority(Bound(conn,self.db.settings),policy_provider=lambda:tuple(self.authority.policy_provider()) if self.authority.policy_provider else self.authority.policies)
            streams=set()
            if not remove:
                # This cache belongs only to the already locked owner operation.
                # Each demand still rechecks its selected actual config/license.
                configs=await self.approved_sources(conn,who) if selected is None else None
                revision = None if selected is None and source_preference == 'auto' else await self.source(conn,who,items,selected,source_preference,instrument,session,configs=configs)
                rows=await (await conn.execute("SELECT DISTINCT s.query->>'market' AS market,s.query->>'code' AS code FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id WHERE d.owner_id=%s AND d.origin='client' AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp() AND s.query->>'kind'='latest'",(who.id,))).fetchall()
                if len({(row["market"],row["code"]) for row in rows}|{(row["market"],row["code"]) for row in items})>256:raise HTTPException(409,"最多保留 256 个行情订阅")
                principal=str(getattr(who,"grant_id",None) or "web:"+who.token_hash)
                for item in items:
                    item_revision = revision or await self.source(conn,who,[item],None,source_preference,instrument,session,configs=configs)
                    _, selected_policy = await self.authority.config(conn,who.id,item_revision)
                    desired = self.query(item,instrument,session,selected_policy)
                    rows=await (await conn.execute("SELECT * FROM market_streams WHERE owner_id=%s AND source_revision=%s AND query->>'kind'='latest' AND query->>'market'=%s AND query->>'code'=%s AND query->>'instrument'=%s AND (%s::text IS NULL OR query->>'session'=%s) FOR UPDATE",(who.id,item_revision,item["market"],item["code"],desired.instrument,desired.session if session is not None else None,desired.session))).fetchall()
                    if len(rows)>1:raise HTTPException(409,"该证券存在多个采集口径，请先明确需求范围")
                    query=query_from(rows[0]["query"]) if rows else desired
                    old=await (await conn.execute("SELECT revision FROM market_demands WHERE owner_id=%s AND stream_id=%s AND principal=%s",(who.id,rows[0]["id"],principal))).fetchone() if rows else None
                    child=uuid5(request_id,"subscription:"+str(item_revision)+":"+canonical(asdict(query)))
                    result=await bound.demand(who,child,item_revision,asdict(query),old["revision"] if old else 0,observed=observe)
                    streams.add(UUID(result["streamId"]))
            else:
                # Old subscriptions are owner-wide intent. Remove client leases from
                # all devices, never the independent price-alert/background demand.
                if selected is not None and not await (await conn.execute("SELECT 1 FROM market_source_configs WHERE owner_id=%s AND revision=%s",(who.id,selected))).fetchone():raise HTTPException(404,"本人来源配置不存在")
                rows=await (await conn.execute("SELECT d.stream_id,s.query FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id WHERE d.owner_id=%s AND d.origin='client' AND d.revoked_at IS NULL AND s.query->>'kind'='latest' AND ((%s::text IS NULL AND COALESCE(s.query->>'instrument','equity')!='index') OR s.query->>'instrument'=%s) AND (%s::uuid IS NULL OR s.source_revision=%s) FOR UPDATE OF d",(who.id,instrument,instrument,selected,selected))).fetchall()
                stream_queries={row["stream_id"]:row["query"] for row in rows}
                wanted={(row["market"],row["code"]) for row in items} if items is not None else None
                streams={row["stream_id"] for row in rows if wanted is None or (row["query"]["market"],row["query"]["code"]) in wanted}
                if streams:
                    await conn.execute("UPDATE market_demands SET revoked_at=clock_timestamp(),revision=revision+1 WHERE owner_id=%s AND origin='client' AND revoked_at IS NULL AND stream_id=ANY(%s)",(who.id,list(streams)))
                    await conn.execute("UPDATE market_streams SET demand_generation=demand_generation+1 WHERE owner_id=%s AND id=ANY(%s)",(who.id,list(streams)))
                    for stream_id in streams:
                        if not await active_demands(conn,{"owner_id":who.id,"id":stream_id,"query":stream_queries[stream_id]}):
                            changed=await (await conn.execute("UPDATE tasks t SET status=CASE WHEN t.status='running' THEN 'cancel_requested' ELSE 'cancelled' END,finished_at=CASE WHEN t.status='queued' THEN clock_timestamp() ELSE t.finished_at END FROM market_data_jobs j WHERE j.task_id=t.id AND j.owner_id=%s AND j.stream_id=%s AND t.status IN ('queued','running') RETURNING t.id,t.status",(who.id,stream_id))).fetchall()
                            for task in changed:await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,%s)",(task["id"],task["status"]))
            result={"requestId":str(request_id),"status":"accepted","revoked":remove,"affectedStreams":len(streams),"collection":"worker_pending" if not remove else "client_demands_revoked","subscriptions":None,"observation":observe,"legacyClientIdempotency":not legacy_generated,"receiptId":str(request_id)}
            if not observe:
                # Automatic quote/index observation needs its own accepted
                # receipt, not an unrelated legacy equity-list projection.
                # Explicit subscription commands keep their strict old DTO.
                try:result.update(await PoolReads(bound).on_connection(conn,who,strict_sources=True))
                except HTTPException as exc:
                    if not remove:raise
                    # A source/other lease's unavailable read must not roll back a
                    # completed owner cancellation. Retain the exact accepted receipt.
                    result["projectionError"]={"status":exc.status_code,"message":str(exc.detail)}
            return await self.authority.save_receipt(conn,who.id,request_id,operation,result),False
