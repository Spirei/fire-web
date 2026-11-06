"""Bounded collection over existing PG tasks; latest observations precede historical backfill."""

import json
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from uuid import uuid4, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .dividend_source_transport import ResponseFailure
from .fx_reference import external_delivery_blocked
from .market_authority import active_demands, query_from
from .market_contract import CURRENCIES, ZONES, digest, futu_rows, number, series_fingerprint, source_time
from .worker import finish, owned_row


class Bound:
    def __init__(self, conn, settings):
        self.conn, self.settings = conn, settings

    @asynccontextmanager
    async def connection(self):
        yield self.conn


async def schedule(authority, limit=100):
    db = authority.db
    scheduled = 0
    async with db.connection() as conn:
        candidates = await (
            await conn.execute(
                """SELECT DISTINCT s.owner_id,s.id,CASE WHEN s.query->>'kind'='latest' THEN 0 ELSE 1 END AS priority FROM market_streams s JOIN market_demands d ON d.owner_id=s.owner_id AND d.stream_id=s.id LEFT JOIN tasks t ON t.id=s.current_task_id
            WHERE d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp())
            AND (t.id IS NULL OR (t.status IN ('cancelled','failed') OR t.status='succeeded' AND s.query->>'kind'<>'latest') AND COALESCE((t.payload->>'demandGeneration')::bigint,0)<s.demand_generation)
            ORDER BY priority,s.owner_id,s.id LIMIT %s""",
                (limit,),
            )
        ).fetchall()
    for item in candidates:
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SELECT id FROM users WHERE id=%s FOR SHARE", (item["owner_id"],))
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("market-owner:" + item["owner_id"],)
            )
            stream = await (
                await conn.execute(
                    "SELECT * FROM market_streams WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (item["owner_id"], item["id"]),
                )
            ).fetchone()
            if not stream or not await active_demands(conn, stream, authority):
                continue
            try:
                _, policy = await authority.config(conn, stream["owner_id"], stream["source_revision"])
                authority.validate_query(policy, query_from(stream["query"]))
            except HTTPException:
                continue
            previous = (
                await (
                    await conn.execute("SELECT * FROM tasks WHERE id=%s", (stream["current_task_id"],))
                ).fetchone()
                if stream["current_task_id"]
                else None
            )
            if (
                previous
                and previous["status"] not in {"cancelled", "failed"}
                and not (previous["status"] == "succeeded" and stream["query"]["kind"] != "latest")
            ):
                continue
            # Every restart needs a new explicit registration generation, including successful history refreshes.
            # Unknown original requests and ordinary reads never create a new generation.
            if previous and stream["demand_generation"] <= previous["payload"]["demandGeneration"]:
                continue
            generation = stream["generation"] + 1
            task_id = uuid4()
            request_id = uuid5(stream["id"], "collection-generation:" + str(generation))
            demands = await active_demands(conn, stream, authority)
            demand_revision = max(row["revision"] for row in demands)
            kind = "market.latest" if stream["query"]["kind"] == "latest" else "market.history"
            payload = {
                "streamId": str(stream["id"]),
                "generation": generation,
                "demandRevision": demand_revision,
                "demandGeneration": stream["demand_generation"],
            }
            await conn.execute(
                "INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,%s,'queued',%s)",
                (task_id, stream["owner_id"], request_id, digest(payload), kind, Jsonb(payload)),
            )
            await conn.execute(
                "INSERT INTO market_data_jobs(task_id,owner_id,stream_id,generation) VALUES(%s,%s,%s,%s)",
                (task_id, stream["owner_id"], stream["id"], generation),
            )
            await conn.execute(
                "UPDATE market_streams SET generation=%s,current_task_id=%s,next_due=clock_timestamp() WHERE owner_id=%s AND id=%s",
                (generation, task_id, stream["owner_id"], stream["id"]),
            )
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (task_id,))
            scheduled += 1
    return scheduled


async def claim(db, worker, *, kind=None):
    async with db.connection() as conn, conn.transaction():
        return await (
            await conn.execute(
                """WITH candidate AS (SELECT t.id FROM tasks t JOIN market_data_jobs j ON j.task_id=t.id
            JOIN market_streams s ON s.owner_id=j.owner_id AND s.id=j.stream_id WHERE t.kind IN ('market.latest','market.history')
            AND (%s::text IS NULL OR t.kind=%s) AND s.next_due<=clock_timestamp() AND (t.status='queued' OR t.status='running' AND t.lease_until<clock_timestamp())
            ORDER BY CASE WHEN t.kind='market.latest' THEN 0 ELSE 1 END,s.next_due,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1)
            UPDATE tasks t SET status='running',lease_owner=%s,lease_version=lease_version+1,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1,
            started_at=COALESCE(started_at,clock_timestamp()) FROM candidate c WHERE t.id=c.id RETURNING t.*""",
                (kind, kind, worker),
            )
        ).fetchone()


async def current(authority, conn, task):
    await conn.execute("SELECT id FROM users WHERE id=%s FOR SHARE", (task["owner_id"],))
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("market-owner:" + task["owner_id"],)
    )
    owned = await owned_row(conn, task)
    if not owned:
        return None, None, "lost"
    stream = await (
        await conn.execute(
            "SELECT s.* FROM market_streams s JOIN market_data_jobs j ON j.owner_id=s.owner_id AND j.stream_id=s.id WHERE j.task_id=%s FOR UPDATE OF s",
            (task["id"],),
        )
    ).fetchone()
    if (
        not stream
        or stream["current_task_id"] != task["id"]
        or stream["generation"] != task["payload"]["generation"]
        or owned["status"] == "cancel_requested"
    ):
        return stream, None, "cancelled"
    if not await active_demands(conn, stream, authority):
        return stream, None, "authorization_revoked"
    try:
        _, policy = await authority.config(conn, stream["owner_id"], stream["source_revision"])
        authority.validate_query(policy, query_from(stream["query"]))
    except HTTPException:
        return stream, None, "source_authorization_unavailable"
    if await external_delivery_blocked(conn):
        return stream, None, "restore_quarantined"
    return stream, policy, None


def decode(policy, query, raw, *, cursor_in=None):
    if policy.source=='tencent':
        from .market_tencent_latest import VERSION,parse
        if policy.source_version!=VERSION or cursor_in is not None:raise ValueError('tencent_protocol_not_installed')
        facts,issues,cursor=parse(raw,query,policy)
        return [{**fact,'fixture':False}for fact in facts],issues,cursor
    if policy.source=='coingecko':
        from .market_crypto_latest import VERSION,parse
        if policy.source_version!=VERSION or cursor_in is not None:
            raise ValueError('crypto_source_protocol_not_installed')
        facts,issues,cursor=parse(raw,query)
        return [{**fact,'fixture':policy.fixture} for fact in facts],issues,cursor
    if policy.source == 'yahoo':
        from .market_yahoo_history import VERSION, parse
        if policy.source_version != VERSION:
            raise ValueError('yahoo_history_version_not_installed')
        facts, issues, cursor = parse(raw, query, cursor_in=cursor_in, policy=policy)
        return [{**fact, 'fixture': policy.fixture} for fact in facts], issues, cursor
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= (2 * 1024 * 1024 if query.kind == 'price_series' else 131072):
        raise ValueError("source_response_size_invalid")
    value = json.loads(
        raw,
        parse_float=__import__("decimal").Decimal,
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non_finite")),
    )
    if not isinstance(value, dict):
        raise TypeError("source_response_invalid")
    cursor = value.get("nextCursor")
    if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 87384):
        raise ValueError("source_cursor_invalid")
    if policy.source == "futu":
        facts, issues = futu_rows(value, query)
    elif policy.fixture:
        if (
            value.get("query") != asdict(query)
            or value.get("licenseRevision") != policy.license_revision
            or not isinstance(value.get("facts"), list)
            or len(value["facts"]) > 1000
        ):
            raise ValueError("controlled_source_scope_invalid")
        facts, issues = [], []
        for index, row in enumerate(value["facts"]):
            try:
                if not isinstance(row, dict) or row.get("currency") != CURRENCIES[query.market]:
                    raise ValueError("currency_unknown")
                at = source_time(row["at"], "UTC")
                if (
                    query.kind != "latest"
                    and not query.start
                    <= at.astimezone(ZoneInfo(ZONES[query.market])).date().isoformat()
                    <= query.through
                ):
                    raise ValueError("source_outside_requested_window")
                if query.kind == "latest":
                    number(row.get("price"), positive=True)
                elif query.kind == "bars":
                    numbers = {key: number(row.get(key), positive=True) for key in ("o", "h", "l", "c")}
                    if numbers["h"] < max(numbers.values()) or numbers["l"] > min(numbers.values()):
                        raise ValueError("invalid_ohlc")
                    if "v" in row:
                        number(row["v"])
                else:
                    number(row.get("price"), positive=True)
                facts.append(
                    {
                        **row,
                        "at": at.isoformat(),
                        "source": policy.source,
                        "sourceVersion": policy.source_version,
                        "fixture": True,
                    }
                )
            except (ValueError, TypeError, KeyError):
                issues.append({"position": index, "reason": "source_record_invalid_or_unknown"})
    else:
        raise ValueError("source_protocol_not_installed")
    return facts, issues, cursor


async def execute(authority, task, transport):
    db = authority.db
    async with db.connection() as conn, conn.transaction():
        stream, policy, reason = await current(authority, conn, task)
        if reason == "lost":
            return reason
        if reason:
            return await stop(conn, db, task, reason)
        job = await (
            await conn.execute("SELECT * FROM market_data_jobs WHERE task_id=%s", (task["id"],))
        ).fetchone()
        query = query_from(stream["query"])
        if getattr(transport, "fixture", False) and db.settings.environment != "test":
            raise ValueError("fixture_transport_outside_test")
    # An archived page beyond the published checkpoint is an uncertain prior
    # attempt. Never reissue its provider call after a crash or permission race.
    async with db.connection() as conn,conn.transaction():
        prior=await(await conn.execute('SELECT 1 FROM market_source_pages WHERE task_id=%s AND page_number>%s',(task['id'],job['page_count']))).fetchone()
        if prior:
            _,_,reason=await current(authority,conn,task)
            if reason=='lost':return reason
            return await stop(conn,db,task,reason or 'source_outcome_unknown')
    source_revision=stream['source_revision']
    origin_instance=str(db.settings.instance_id)
    reply_failure=None
    try:
        try:
            raw, representation = await transport.read(policy, query, job["cursor"])
        except ResponseFailure as observed:
            # fetch_page already bounds this body. An HTTP rejection or retained
            # prefix is evidence only, never valid source facts.
            if type(observed.status) is not int or not 100<=observed.status<=599 or type(observed.complete) is not bool:
                raise ValueError('source_reply_metadata_invalid') from None
            raw,representation=observed.raw,'http_response_body'
            reply_failure={'reason':'source_http_or_size_error','httpStatus':observed.status,'complete':observed.complete}
        if not isinstance(raw,bytes) or len(raw)>2*1024*1024 or not isinstance(representation,str):
            raise ValueError('source_raw_budget_invalid')
    except Exception:  # noqa: BLE001 - no usable complete body or typed bounded prefix was returned
        async with db.connection() as conn,conn.transaction():
            _,_,reason=await current(authority,conn,task)
            if reason=='lost':return reason
            return await stop(conn,db,task,reason or 'source_outcome_unknown')
    decode_failed=reply_failure is not None
    if reply_failure:
        facts,issues,cursor=[],[reply_failure],None
    else:
        try:
            facts, issues, cursor = decode(policy, query, raw, cursor_in=job['cursor'])
            cutoff = (authority.clock() if authority.clock else datetime.now(UTC)) + timedelta(seconds=5)
            accepted=[]
            for fact in facts:
                if source_time(fact['at'],'UTC')>cutoff:
                    issues.append({'reason':'source_future_observation','at':fact['at']})
                else:accepted.append(fact)
            facts=accepted
        except Exception:  # noqa: BLE001 - preserve malformed original, no guessed facts
            facts,issues,cursor=[],[{'reason':'source_decode_failed'}],None
            decode_failed=True
    page_id=uuid4()
    async with db.connection() as conn,conn.transaction():
        # Saving an already received body is independent of current collection
        # permission. Immutable provenance always retains its original license.
        binding=await(await conn.execute('''SELECT t.id FROM tasks t JOIN market_data_jobs j ON j.task_id=t.id AND j.owner_id=t.owner_id JOIN market_streams s ON s.owner_id=j.owner_id AND s.id=j.stream_id JOIN market_source_configs c ON c.owner_id=s.owner_id AND c.revision=s.source_revision WHERE t.id=%s AND t.owner_id=%s AND j.stream_id=%s AND j.generation=%s AND s.source_revision=%s AND c.origin_instance=%s FOR UPDATE OF t''',(task['id'],task['owner_id'],stream['id'],job['generation'],source_revision,origin_instance))).fetchone()
        if not binding or str(db.settings.instance_id)!=origin_instance:return 'source_archive_binding_unavailable'
        previous=await(await conn.execute('SELECT COALESCE(max(page_number),0) AS n FROM market_source_pages WHERE task_id=%s',(task['id'],))).fetchone()
        page=previous['n']+1
        unclosed=(cursor is not None and (query.kind=='latest' or cursor==job['cursor']) or query.kind!='latest' and page>100)
        if unclosed:issues.append({'reason':'source_pagination_unclosed'})
        await conn.execute(
            """INSERT INTO market_source_pages(owner_id,id,task_id,source_revision,page_number,cursor_in,cursor_out,representation,raw_bytes,raw_sha256,issues,observed_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,COALESCE(%s,clock_timestamp()))""",
            (
                task["owner_id"],
                page_id,
                task["id"],
                source_revision,
                page,
                job["cursor"],
                cursor,
                representation,
                raw,
                digest(raw),
                Jsonb(issues),
                authority.clock() if authority.clock else None,
            ),
        )
    async with db.connection() as conn,conn.transaction():
        stream,policy,reason=await current(authority,conn,task)
        if reason=='lost':return reason
        if reason:return await stop(conn,db,task,reason)
        if decode_failed:return await stop(conn,db,task,'source_outcome_unknown')
        changed = False
        for fact in facts:
            at = source_time(fact["at"], "UTC")
            result = await (
                await conn.execute(
                    """INSERT INTO market_facts(owner_id,source_revision,series_fingerprint,stream_id,page_id,id,source_time,contents,fingerprint)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,source_revision,series_fingerprint,fingerprint) DO NOTHING RETURNING id""",
                    (
                        task["owner_id"],
                        stream["source_revision"],
                        series_fingerprint(query),
                        stream["id"],
                        page_id,
                        uuid4(),
                        at,
                        Jsonb(fact),
                        digest(fact),
                    ),
                )
            ).fetchone()
            changed = changed or result is not None
        if changed:
            await conn.execute(
                "INSERT INTO market_cache_generations(owner_id) VALUES(%s) ON CONFLICT(owner_id) DO UPDATE SET generation=market_cache_generations.generation+1",
                (task["owner_id"],),
            )
        await conn.execute(
            "UPDATE market_data_jobs SET cursor=%s,page_count=%s,state=%s WHERE task_id=%s",
            (cursor, page, "partial" if cursor else "observed", task["id"]),
        )
        if unclosed:
            return await stop(conn, db, task, "source_pagination_unclosed")
        if query.kind != "latest" and cursor is None:
            rows = await (
                await conn.execute(
                    "SELECT id,issues,raw_bytes,cursor_in FROM market_source_pages WHERE task_id=%s ORDER BY page_number",
                    (task["id"],),
                )
            ).fetchall()
            observed_times = set()
            for page_row in rows:
                page_facts, _, _ = decode(policy, query, bytes(page_row["raw_bytes"]), cursor_in=page_row['cursor_in'])
                rejected_times = {
                    issue["at"]
                    for issue in page_row["issues"]
                    if issue.get("reason") == "source_future_observation" and "at" in issue
                }
                observed_times.update(fact["at"] for fact in page_facts if fact["at"] not in rejected_times)
            assurance = ("controlled_rt_observed_snapshot" if policy.fixture else "source_rt_observed_snapshot") if query.kind=='price_series' else "controlled_terminal_pages" if policy.fixture else "source_terminal_pages"
            if not observed_times:
                assurance += "_empty"
            if any(row["issues"] for row in rows):
                assurance += "_partial_records"
            await conn.execute(
                """INSERT INTO market_coverage_receipts(owner_id,stream_id,task_id,page_ids,terminal_page,window_from,window_through,assurance,point_count)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    task["owner_id"],
                    stream["id"],
                    task["id"],
                    [row["id"] for row in rows],
                    page_id,
                    query.start,
                    query.through,
                    assurance,
                    len(observed_times),
                ),
            )
            await finish(
                Bound(conn, db.settings),
                task,
                result={
                    "streamId": str(stream["id"]),
                    "coverage": assurance,
                    "fullBusinessHistoryVerified": False,
                },
            )
            return "complete"
        await conn.execute(
            "UPDATE market_streams SET next_due=clock_timestamp()+make_interval(secs=>%s) WHERE owner_id=%s AND id=%s",
            (5 if query.kind == "latest" else 0, task["owner_id"], stream["id"]),
        )
        await conn.execute(
            "UPDATE tasks SET status='queued',attempts=0,lease_until=NULL,result=%s WHERE id=%s",
            (
                Jsonb(
                    {"streamId": str(stream["id"]), "state": "observed" if facts else "unknown", "page": page}
                ),
                task["id"],
            ),
        )
        return "observed" if query.kind == "latest" else "more"


async def stop(conn, db, task, reason):
    if reason in {
        "cancelled",
        "authorization_revoked",
        "source_authorization_unavailable",
        "restore_quarantined",
    }:
        await conn.execute("UPDATE tasks SET status='cancel_requested' WHERE id=%s", (task["id"],))
        await finish(
            Bound(conn, db.settings), task, result={"reason": reason, "providerCallsReplayed": False}
        )
    else:
        await finish(
            Bound(conn, db.settings),
            task,
            result={"reason": reason, "providerCallsReplayed": False},
            error_code=reason,
        )
    await conn.execute(
        "UPDATE market_data_jobs SET state=%s,last_source_error=%s WHERE task_id=%s",
        (reason, reason, task["id"]),
    )
    return reason
