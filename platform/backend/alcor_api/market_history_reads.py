"""Owner/license/period-isolated reads of already observed PG history. No source IO."""

from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .market_authority import query_from
from .market_contract import ZONES, code, series_fingerprint
from .market_history_evidence import bounded_history_read
from .native_app_auth import CLIENT
from .request_timing import measure
from .security import lock_read_identity


class HistoryUnavailable(HTTPException):
    """The requested authorized history has no collected facts."""


class LicensedHistory:
    def __init__(self, authority, *, automatic=False):
        self.authority, self.db = authority, authority.db
        self.automatic=automatic

    async def authorize_history_read(self, conn, who):
        identity = await lock_read_identity(conn, who, require_admin=False)
        # The lock returns the current user role (and, for App grants, the
        # client) from the same proof row; no second identity read is needed.
        if not identity or identity["role"] != who.role:
            raise HTTPException(403, "账号权限已变化")
        if getattr(who, "native_client", False) and identity.get("client_id") != CLIENT:
            raise HTTPException(401, "客户端连接已变化")

    @bounded_history_read
    async def read(
        self,
        who,
        market,
        symbol,
        *,
        frame,
        adjust,
        instrument="equity",
        session="REGULAR",
        kind="bars",
        minute_series_fallback=False,
        minute_window=None,
        source_revision=None,
        limit=3300,
    ):
        if type(limit) is not int or not 1 <= limit <= 16001:
            raise HTTPException(400, "历史读取数量无效")
        try:
            symbol = code(market, symbol)
            revision = UUID(str(source_revision)) if source_revision is not None else None
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "历史代码或来源版本无效") from exc
        requested_revision = revision

        async def select(conn):
            async def candidates(candidate_kind):
                return await self.choices(
                    conn, who.id, market, symbol, frame=frame, adjust=adjust,
                    instrument=instrument, session=session, kind=candidate_kind,
                    revision=requested_revision, prefer_full=limit >= 3300,
                )

            choices, retained = await candidates(kind)
            if minute_series_fallback and not retained and len(choices) <= 1:
                preferred = next(iter(choices), None)
                if preferred is not None:
                    async def latest(key):
                        window = " AND source_time >= %s AND source_time < %s" if minute_window else ""
                        row = await (await conn.execute(
                            """SELECT max(source_time) AS at FROM market_facts
                               WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s""" + window,
                            (who.id, *key, *(minute_window or ())),
                        )).fetchone()
                        return row["at"]
                    bars_end = await latest(preferred)
                    if bars_end is not None:
                        if choices[preferred][0].source in ("futu", "tencent", "eastmoney", "yahoo") and market == "US":
                            alternatives, _ = await candidates("price_series")
                            for key, value in alternatives.items():
                                if key[0] == preferred[0]:
                                    end = await latest(key)
                                    if end is not None and end > bars_end:
                                        return {key: value}, []
                        return choices, retained
                return await candidates("price_series")
            return choices, retained

        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            with measure("history_authorize"):
                await self.authorize_history_read(conn, who)
            with measure("history_select"):
                choices, retained = await select(conn)
            if not choices:
                if retained:
                    raise HTTPException(403, "历史原件仍保留，但当前来源展示许可不可用，请撤下旧数据")
                raise HistoryUnavailable(503, "尚无本人已登记的该口径真实历史，未用其他周期或当前价格替代")
            if len(choices) != 1:
                raise HTTPException(409, "存在多个历史来源，请显式选择来源版本及复权口径")
            (revision, fingerprint), (policy, query) = next(iter(choices.items()))
            # Bound the raw read before applying the proof/page budget. Long-lived
            # symbols may retain more than 16,000 minutes across unrelated days.
            window_clause = ""
            arguments = [who.id, revision, fingerprint]
            if minute_window is not None:
                window_clause = " AND source_time >= %s AND source_time < %s"
                arguments.extend(minute_window)
            rows = await (
                await conn.execute(
                    """SELECT * FROM (SELECT DISTINCT ON(source_time) * FROM market_facts
                       WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s"""
                    + window_clause
                    + " ORDER BY source_time DESC,sequence DESC) newest ORDER BY source_time DESC LIMIT %s",
                    (*arguments, limit),
                )
            ).fetchall()
            if not rows:
                raise HistoryUnavailable(503, "该口径历史尚无已采集记录")
            from .market_history_evidence import load_history_evidence, verify_history_evidence
            with measure("history_evidence_load"):
                evidence = await load_history_evidence(conn, who.id, revision, rows)
        # Decoding overlapping RT originals can inspect tens of thousands of
        # facts. It must own neither a pool connection nor identity locks.
        await verify_history_evidence(who.id, revision, evidence, policy)
        # An old repeatable-read snapshot cannot authorize a reply after the
        # CPU await: recheck the current identity, license and source selection.
        async with self.db.connection() as conn, conn.transaction():
            with measure("history_authorize"):
                await self.authorize_history_read(conn, who)
            with measure("history_select"):
                current, retained = await select(conn)
            if not current and retained:
                raise HTTPException(403, "历史原件仍保留，但当前来源展示许可不可用，请撤下旧数据")
            selected = current.get((revision, fingerprint)) if len(current) == 1 else None
            if selected is None or selected[0].fingerprint != policy.fingerprint:
                raise HTTPException(409, "历史来源或展示口径已变化，请重新读取")
        return list(reversed(rows)), policy, query, str(revision)

    async def choices(self, conn, owner, market, symbol, *, frame, adjust, instrument, session, kind, revision=None, prefer_full=False):
        streams = await (await conn.execute("""SELECT DISTINCT ON(source_revision,query->>'adjust') * FROM market_streams WHERE owner_id=%s
            AND query->>'kind'=%s AND query->>'frame'=%s AND query->>'market'=%s AND query->>'code'=%s
            AND (%s::text IS NULL OR query->>'adjust'=%s) AND query->>'session'=%s AND query->>'instrument'=%s
            AND (%s::uuid IS NULL OR source_revision=%s) ORDER BY source_revision,query->>'adjust',id LIMIT 1001""",
            (owner, kind, frame, market, symbol, adjust, adjust, session, instrument, revision, revision))).fetchall()
        if len(streams) > 1000:
            raise HTTPException(503, "历史来源目录超过读取预算")
        choices, retained = {}, {}
        for stream in streams:
            try:
                _, policy = await self.authority.config(conn, owner, stream['source_revision'])
                query = query_from(stream['query'])
                self.authority.validate_query(policy, query)
            except HTTPException:
                # Revocation stops display/collection according to current license, never erases originals.
                retained[str(stream['source_revision'])] = {'sourceRevision': str(stream['source_revision']), 'state': 'retained_unavailable'}
                continue
            choices[(stream['source_revision'], series_fingerprint(query))] = (policy, query)
        if revision is not None and not streams:
            exists = await (await conn.execute('SELECT 1 FROM market_source_configs WHERE owner_id=%s AND revision=%s', (owner,revision))).fetchone()
            if not exists:
                raise HTTPException(404, '本人来源版本不存在')
            try:
                await self.authority.config(conn, owner, revision)
            except HTTPException:
                retained[str(revision)] = {'sourceRevision': str(revision), 'state': 'retained_unavailable'}
        if self.automatic and adjust is None:
            raw={key:value for key,value in choices.items() if value[1].adjust=='none'}
            if raw:choices=raw
        if self.automatic and revision is None and len(choices)>1 and all(p.source in ('futu','yahoo','eastmoney','tencent') for p,q in choices.values()):
            observed={}
            times={}
            for key,value in choices.items():
                latest=await (await conn.execute('SELECT max(source_time) AS at FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s',(owner,key[0],key[1]))).fetchone()
                if latest['at'] is not None:observed[key]=value;times[key]=latest['at']
            if observed:choices=observed
            if kind=='price_series' and times:
                newest=max(times.values())
                choices={key:value for key,value in choices.items() if times.get(key)==newest}
            elif kind=='bars' and frame=='day' and times:
                # Daily providers timestamp the same market day differently.
                # Compare observed local dates, then retain configured source
                # preference. Older partial backfill must not hide a newer
                # licensed series; no rows from different sources are merged.
                days={key:stamp.astimezone(ZoneInfo(ZONES[market])).date() for key,stamp in times.items()}
                newest=max(days.values())
                choices={key:value for key,value in choices.items() if days.get(key)==newest}
                if prefer_full and len(choices) > 1:
                    counts = {}
                    for key in choices:
                        observed_days = await (await conn.execute(
                            """SELECT count(DISTINCT (source_time AT TIME ZONE %s)::date) AS count
                               FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s""",
                            (ZONES[market], owner, *key),
                        )).fetchone()
                        counts[key] = observed_days['count']
                    fullest = max(counts.values())
                    choices = {key: value for key, value in choices.items() if counts[key] == fullest}
            order=getattr(self.db.settings,'_legacy_quote_order',None) or ['futu','tencent','eastmoney','yahoo']
            for provider in order:
                selected={key:value for key,value in choices.items() if value[0].source==provider}
                if selected:choices=selected;break
        return choices, list(retained.values())
