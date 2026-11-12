"""Read-only legacy views of the single PG latest-demand / Worker authority."""

from fastapi import HTTPException

from .market_authority import active_demands
from .market_contract import MARKETS
from .security import lock_read_identity


def milliseconds(value):
    return int(value.timestamp()*1000)


class PoolReads:
    def __init__(self, authority):
        self.authority, self.db = authority, authority.db

    async def read(self, who, *, market=None, shared=False, pool=False, strict_sources=False):
        if market is not None and market not in MARKETS:
            raise HTTPException(400, "不支持的市场")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            return await self.on_connection(conn,who,market=market,shared=shared,pool=pool,strict_sources=strict_sources)

    async def on_connection(self,conn,who,*,market=None,shared=False,pool=False,strict_sources=False):
        # Reuse the existing credential authority. Locks do not initialize data,
        # and legacy Web reads must not be reinterpreted as new-Web sessions.
        await lock_read_identity(conn,who,require_admin=shared)
        user=await (await conn.execute("SELECT role FROM users WHERE id=%s",(who.id,))).fetchone()
        if not user or user["role"]!=who.role:
            raise HTTPException(403,"读取权限已变化")
        now=(await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
        rows=await (await conn.execute(
            "SELECT d.*,s.source_revision,s.query,s.current_task_id,t.status AS task_status,t.lease_until "
            "FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id "
            "LEFT JOIN tasks t ON t.id=s.current_task_id WHERE (%s OR d.owner_id=%s) "
            "AND (%s OR d.origin='client') AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp()) "
            "AND s.query->>'kind'='latest' AND COALESCE(s.query->>'instrument','equity')!='index' AND (%s::text IS NULL OR s.query->>'market'=%s) "
            "ORDER BY d.owner_id,d.stream_id,d.principal LIMIT 4097",(shared,who.id,shared or pool,market,market)
        )).fetchall()
        if len(rows)>4096:
            raise HTTPException(409,"行情需求超过本次完整读取范围")
        stamps={}
        if rows:
            accepted=await (await conn.execute(
                "SELECT owner_id,result->>'streamId' AS stream_id,max(created_at) AS at FROM market_data_operations "
                "WHERE owner_id=ANY(%s) AND result->>'streamId'=ANY(%s) AND result->>'revoked'='false' "
                "GROUP BY owner_id,result->>'streamId'",
                (list({row["owner_id"] for row in rows}),list({str(row["stream_id"]) for row in rows}))
            )).fetchall()
            stamps={(row["owner_id"],row["stream_id"]):row["at"] for row in accepted}
        source_checked={};source_errors={};stream_active={};entries={};ongoing={}
        for row in rows:
            source=(row["owner_id"],row["source_revision"])
            if source not in source_checked:
                try:
                    await self.authority.config(conn,*source)
                    source_checked[source]=True
                except HTTPException as exc:
                    source_checked[source]=False
                    source_errors[source]=exc
            stream_key=(row["owner_id"],row["stream_id"])
            if stream_key not in stream_active:
                stream_active[stream_key]={d["principal"] for d in await active_demands(conn,{"owner_id":row["owner_id"],"id":row["stream_id"],"query":row["query"]})}
            if row["principal"] not in stream_active[stream_key]:
                continue
            if row["origin"]!="client":
                # The old entry contract requires finite client lease timestamps.
                # Keep ongoing business demand in a separate truthful projection;
                # never invent a client request time, expiry or cancellation right.
                query=row["query"];key=(query["market"],query["code"])
                available=source_checked[source]
                updating=bool(available and row["task_status"]=="running" and row["lease_until"] and row["lease_until"]>now)
                value=ongoing.setdefault(key,{"market":key[0],"code":key[1],"name":key[1],"icon":"",
                    "lastRequestedAt":None,"expiresAt":None,"registeredAt":milliseconds(row["created_at"]),
                    "lifetime":"while_rule_enabled","cancellable":False,"updating":False,"sources":[]})
                value["registeredAt"]=min(value["registeredAt"],milliseconds(row["created_at"]))
                value["updating"]|=updating
                origin={"kind":row["origin"],"ownership":"mine" if row["owner_id"]==who.id else "shared",
                    "permission":"current" if available else "unavailable","cancellable":False}
                if origin not in value["sources"]:value["sources"].append(origin)
                continue
            if strict_sources and not source_checked[source]:
                # Finite legacy entries have no typed unavailable-source DTO.
                raise source_errors[source]
            if row["expires_at"] is None:
                raise HTTPException(409,"订阅期限未知，不能伪造有效期限")
            # Real accepted user request time from its immutable PG receipt;
            # never derive it from expiry/hot TTL, the current time, or holdings.
            stamp=stamps.get((row["owner_id"],str(row["stream_id"])))
            if stamp is None:
                raise HTTPException(409,"订阅原请求时间未知，不能伪造最近请求")
            query=row["query"];symbol=(query["market"],query["code"])
            requested=milliseconds(stamp);expires=milliseconds(row["expires_at"])
            admitted=row["current_task_id"] is not None and row["task_status"] in ("queued","running")
            hot=now<row["hot_until"]
            updating=bool(row["task_status"]=="running" and row["lease_until"] and row["lease_until"]>now)
            source_available=source_checked[source]
            if pool and not admitted:
                proof=await (await conn.execute("SELECT bool_or(coalesce(result->>'observation','false')!='true') AS explicit,count(*) AS reads FROM market_data_operations WHERE owner_id=%s AND result->>'streamId'=%s AND result->>'revoked'='false' AND created_at>clock_timestamp()-interval '7 days'",(row['owner_id'],str(row['stream_id'])))).fetchone()
                pending_state='dormant' if proof['explicit'] or proof['reads']>=2 else 'candidate'
            else:
                pending_state='dormant'
            current={"market":symbol[0],"code":symbol[1],"lastRequestedAt":requested,"expiresAt":expires,
                "state":("hot" if hot else "dormant") if (not pool or admitted) and source_available else pending_state,
                "sourcePermission":"current" if source_available else "unavailable"}
            if pool:
                current.update(updating=updating,name=symbol[1],icon="")
            if pool:current['updating']=current['updating'] and source_available
            old=entries.get(symbol)
            if old:
                current["lastRequestedAt"]=max(old["lastRequestedAt"],requested)
                current["expiresAt"]=max(old["expiresAt"],expires)
                states={old["state"],current["state"]}
                current["state"]="hot" if "hot" in states else "dormant" if "dormant" in states else "candidate"
                if pool:current["updating"]=old["updating"] or updating
            entries[symbol]=current
        values=list(entries.values())
        if not pool:
            values.sort(key=lambda item:(item["market"],item["code"]))
            return {"subscriptions":values}
        values.sort(key=lambda item:(-item["lastRequestedAt"],item["market"]+":"+item["code"]))
        ongoing_values=sorted(ongoing.values(),key=lambda item:(item["market"],item["code"]))
        for value in ongoing_values:value["sources"].sort(key=lambda item:(item["kind"],item["ownership"],item["permission"]))
        await enrich_metadata(self.db,values+ongoing_values)
        return {"scope":"shared" if shared else "mine","at":milliseconds(now),"entries":values,
            "entryScope":"finite_client_leases","ongoingEntrySchema":"nonexpiring-demands-v1","ongoingEntries":ongoing_values}


async def enrich_metadata(db,entries):
    """Use the registered public catalog and verified originals, never a file scan."""
    from .asset_lookup_catalog import AssetCatalog
    catalog=AssetCatalog(db)
    for start in range(0,len(entries),100):
        batch=entries[start:start+100]
        keys=[key for row in batch for key in ([{"type":"crypto","market":"","code":row["code"]},{"type":"metal","market":"","code":row["code"]}] if row["market"]=="ASSET" else [{"type":"stock","market":row["market"],"code":row["code"]}])]
        try:
            result=await catalog.lookup(keys)
        except HTTPException:
            for row in batch:row['metadataState']='unavailable'
            continue
        for row in batch:
            asset=next((item for item in result['assets'] if item['code'].upper()==row['code'] and (item['type'] in ('crypto','metal') if row['market']=='ASSET' else item['type']=='stock' and item['market']==row['market'])),None)
            row['metadataState']='registered_public_metadata' if asset else 'missing'
            if asset:
                row['name']=asset['name'] or row['code']
                row['icon']=asset.get('imageUrl') or ''
