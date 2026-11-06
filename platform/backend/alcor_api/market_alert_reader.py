"""F19 reads the one PG market authority; it never calls a supplier or renews demand."""

from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .market_contract import ZONES, Query, digest, series_fingerprint, source_time


def rule_queries(rule, now):
    config = rule['config']
    market, symbol = config['market'], config['code']
    extended = market=='US' and config['extended']
    queries = [Query('latest',market,symbol,session=session).validate()
               for session in (('REGULAR','PRE','AFTER','OVERNIGHT') if extended else ('REGULAR',))]
    day = now.astimezone(ZoneInfo(ZONES[market])).date()
    # Real minute points have their own purpose and are never synthesized from snapshots.
    queries.extend(Query('price_series',market,symbol,frame='minute',session=session,
                         start=(day-timedelta(days=1)).isoformat(),through=day.isoformat()).validate()
                   for session in (('ALL','REGULAR') if extended else ('REGULAR',)))
    return queries


async def rule_source(conn, authority, rule, now):
    explicit = rule['config'].get('sourceRevision')
    rows = await (await conn.execute('''SELECT * FROM market_source_configs WHERE owner_id=%s
        AND (%s::uuid IS NULL OR revision=%s) ORDER BY created_at DESC,revision DESC LIMIT 1001''',
        (rule['owner_id'],explicit,explicit))).fetchall()
    if len(rows)>1000:
        return None
    choices = {}
    for row in rows:
        try:
            _,policy = await authority.config(conn,rule['owner_id'],row['revision'])
            supported = []
            for query in rule_queries(rule,now):
                try:
                    authority.validate_query(policy,query)
                except HTTPException:
                    continue
                supported.append(query)
            if supported:
                if policy.source=='futu' and any(query.kind=='price_series' for query in supported):
                    supported = [next(query for query in supported if query.kind=='price_series')]
                choices.setdefault(policy.fingerprint,(row,policy,supported))
        except HTTPException:
            continue
    # Re-registering one policy does not create a second provider. Distinct providers require selection.
    return next(iter(choices.values())) if len(choices)==1 else None


class SharedQuotes:
    fixture = False

    def __init__(self, authority):
        self.authority, self.db = authority, authority.db

    @property
    def fingerprint(self):
        policies = (
            tuple(self.authority.policy_provider())
            if self.authority.policy_provider
            else self.authority.policies
        )
        return digest(
            {"protocol": "shared-pg-quote-v1", "policies": sorted(row.fingerprint for row in policies)}
        )

    async def authorize_on_connection(self, conn, rule, quote):
        # Alert work already holds owner/grant locks. Never block here in the
        # inverse market->grant projection order: defer and retry the same job.
        acquired=await(await conn.execute(
            'SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) acquired',
            ('market-owner:'+rule['owner_id'],))).fetchone()
        if not acquired['acquired']:
            return 'market_authority_busy'
        now=self.authority.clock() if self.authority.clock else datetime.now(UTC)
        selected=await rule_source(conn,self.authority,rule,now)
        if selected is None:
            return 'source_authorization_changed'
        config,policy,_queries=selected
        expected=policy.source_version+':'+str(config['revision'])+':'+policy.license_revision
        if quote.owner!=rule['owner_id'] or quote.account!=rule['account_id'] or quote.source_id!=policy.source or quote.version!=expected:
            return 'source_authorization_changed'
        return None

    async def read(self, rule):
        if rule["account_id"] != rule["owner_id"] or rule["source_identity"] != "platform":
            return None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            now = self.authority.clock() if self.authority.clock else datetime.now(UTC)
            selected = await rule_source(conn,self.authority,rule,now)
            if selected is None:
                return None
            config,policy,queries = selected
            rows = await (await conn.execute('''SELECT * FROM (SELECT DISTINCT ON(f.series_fingerprint)
                f.*,p.raw_bytes,p.raw_sha256,p.observed_at,p.representation,p.cursor_in,s.query AS source_query
                FROM market_facts f JOIN market_source_pages p ON p.owner_id=f.owner_id AND p.id=f.page_id
                JOIN market_streams s ON s.owner_id=f.owner_id AND s.id=f.stream_id
                WHERE f.owner_id=%s AND f.source_revision=%s AND f.series_fingerprint=ANY(%s)
                ORDER BY f.series_fingerprint,f.source_time DESC,f.sequence DESC) points ORDER BY source_time DESC''',
                (rule['owner_id'],config['revision'],[series_fingerprint(query) for query in queries]))).fetchall()
            from .price_alert_quotes import Quote
            candidates = []
            for row in rows:
                if row['source_time']<rule['activated_at'] or rule['last_quote_at'] is not None and row['source_time']<=rule['last_quote_at']:
                    continue
                value = row['contents']
                if (value.get('source')!=policy.source or value.get('sourceVersion')!=policy.source_version
                        or source_time(value['at'],'UTC')!=row['source_time'] or digest(bytes(row['raw_bytes']))!=row['raw_sha256']):
                    continue
                witness = None
                if row['source_query'].get('kind')=='price_series':
                    if (policy.source!='futu' or policy.source_version!='futu-sdk-records-v1'
                            or value.get('dataKind')!='provider_real_time_time_frame' or value.get('sourceBlank') is not False
                            or row['representation']!='sdk_json_representation_not_wire_bytes'):
                        continue
                    from .market_authority import query_from
                    from .market_worker import decode
                    facts,_,_ = decode(policy,query_from(row['source_query']),bytes(row['raw_bytes']),cursor_in=row['cursor_in'])
                    if not any(all(fact.get(key)==value.get(key) for key in ('at','price','currency','source','sourceVersion','session','dataKind','sourceBlank')) for fact in facts):
                        continue
                    if not -5<=(now-row['source_time']).total_seconds()<=90:
                        continue
                    witness = 'source_rt_observed_point'
                candidates.append((witness,row,value))
            if not candidates:
                return None
            # Proven real points can be used without claiming that a provider cache is disabled.
            witness,row,value = next((item for item in candidates if item[0]),candidates[0])
            cached = value.get('cached') if type(value.get('cached')) is bool else None
            if policy.source=='futu' and value.get('snapshotMetricsVersion')!=2:
                cached = None
            return Quote(
                rule["owner_id"],
                rule["account_id"],
                rule["source_identity"],
                policy.source,
                policy.source_version + ":" + str(config["revision"]) + ":" + policy.license_revision,
                rule['config']['market'],
                rule['config']['code'],
                Decimal(value["price"]),
                value["currency"],
                source_time(value["at"], "UTC"),
                row["observed_at"],
                value.get("session", "UNKNOWN"),
                cached,
                row["raw_bytes"],
                policy.fixture,
                witness,
            )


async def project_alert_demands(authority):
    """Worker projection of explicitly enabled F19 subscriptions, never a GET side effect."""
    from .price_alert_service import active_subscriptions

    async with authority.db.connection() as conn:
        exists = await (await conn.execute("SELECT to_regclass('price_alert_rules') AS name")).fetchone()
        if exists["name"] is None:
            return 0
        rules = await (
            await conn.execute(
                "SELECT * FROM price_alert_rules WHERE state='enabled' AND deleted_at IS NULL ORDER BY owner_id,id LIMIT 200"
            )
        ).fetchall()
    total = 0
    for rule in rules:
        async with authority.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT id FROM users WHERE id=%s FOR SHARE", (rule["owner_id"],))
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("market-owner:" + rule["owner_id"],)
            )
            current = await (
                await conn.execute(
                    "SELECT * FROM price_alert_rules WHERE owner_id=%s AND id=%s AND revision=%s AND state='enabled'",
                    (rule["owner_id"], rule["id"], rule["revision"]),
                )
            ).fetchone()
            if not current or not await active_subscriptions(conn, current, lock=False):
                continue
            now = authority.clock() if authority.clock else datetime.now(UTC)
            selected = await rule_source(conn,authority,current,now)
            if selected is None:
                continue
            config,_policy,queries = selected
            user = await (await conn.execute("SELECT session_version FROM users WHERE id=%s",(rule["owner_id"],))).fetchone()
            principal = "price-alert:"+str(rule["id"])+":"+str(rule["revision"])
            for query in queries:
                stream = await (await conn.execute("""INSERT INTO market_streams(owner_id,source_revision,id,query_fingerprint,query)
                    VALUES(%s,%s,%s,%s,%s) ON CONFLICT(owner_id,source_revision,query_fingerprint)
                    DO UPDATE SET query_fingerprint=excluded.query_fingerprint RETURNING *""",
                    (rule["owner_id"],config["revision"],uuid4(),digest(asdict(query)),Jsonb(asdict(query))))).fetchone()
                row = await (await conn.execute("""INSERT INTO market_demands(owner_id,stream_id,principal,session_version,expires_at,hot_until,origin)
                    VALUES(%s,%s,%s,%s,NULL,clock_timestamp()+interval '90 seconds','price.alert') ON CONFLICT DO NOTHING RETURNING principal""",
                    (rule["owner_id"],stream["id"],principal,user["session_version"]))).fetchone()
                total += row is not None
                if row is not None:
                    await conn.execute("UPDATE market_streams SET demand_generation=demand_generation+1 WHERE owner_id=%s AND id=%s",
                                       (rule["owner_id"],stream["id"]))
                elif query.kind=='price_series':
                    # A live rule explicitly authorizes bounded new observations, not replay of an unknown call.
                    # Known completed RT snapshots may advance every 30s; failed/unknown jobs require an explicit new intent.
                    await conn.execute("""UPDATE market_streams s SET demand_generation=s.demand_generation+1
                        FROM tasks t WHERE s.owner_id=%s AND s.id=%s AND t.id=s.current_task_id AND t.status='succeeded'
                        AND s.next_due<=clock_timestamp()-interval '30 seconds'
                        AND s.demand_generation=COALESCE((t.payload->>'demandGeneration')::bigint,0)""",
                        (rule["owner_id"],stream["id"]))
    return total


async def alert_demand_alive(conn, row, stream, authority=None):
    from .price_alert_service import active_subscriptions

    try:
        prefix, identifier, revision = row["principal"].split(":")
        identifier = UUID(identifier)
        revision = int(revision)
    except (TypeError, ValueError):
        return False
    if prefix != "price-alert":
        return False
    rule = await (
        await conn.execute(
            "SELECT * FROM price_alert_rules WHERE owner_id=%s AND id=%s AND revision=%s AND state='enabled' AND deleted_at IS NULL",
            (row["owner_id"], identifier, revision),
        )
    ).fetchone()
    if not (rule and rule["account_id"]==rule["owner_id"] and rule["source_identity"]=="platform"
            and await active_subscriptions(conn,rule,lock=False)):
        return False
    # Validate the exact declared rule identity/session/window. Source revocation is separately checked by authority.config.
    if rule["config"].get("sourceRevision") and str(stream["source_revision"])!=rule["config"]["sourceRevision"]:
        return False
    now = authority.clock() if authority is not None and authority.clock else datetime.now(UTC)
    if authority is not None:
        selected = await rule_source(conn,authority,rule,now)
        return bool(selected and selected[0]['revision']==stream['source_revision']
                    and stream['query'] in [asdict(query) for query in selected[2]])
    return stream["query"] in [asdict(query) for query in rule_queries(rule,now)]
