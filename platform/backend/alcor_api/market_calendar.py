"""Typed PostgreSQL annual cash-equity plans. Never a live trading-status feed."""

import hashlib
import json
from datetime import date
from pathlib import Path

from .market_reference import calendar_unknown
from .reference_integrity import calendar_markets, calendar_projection, calendar_release

BUILTIN_PATH = Path(__file__).with_name("data") / "market_calendar_2026.json"
BUILTIN_SHA = "096359ec186f1c996bcfa5b47eb72632426a4f836cdab16c691cf7efb95de859"


class Calendars:
    def __init__(self, db):
        self.db = db

    async def ensure_builtin(self):
        return await self.import_release(BUILTIN_PATH.read_bytes(), BUILTIN_SHA)

    async def import_release(self, raw, expected_sha):
        if (
            not isinstance(raw, bytes)
            or len(raw) > 2_000_000
            or hashlib.sha256(raw).hexdigest() != expected_sha
        ):
            raise ValueError("source bytes/digest mismatch")
        value = json.loads(raw)
        cfg = value["configuration"]
        revision = cfg["calendar_version"]
        if (
            cfg["schema_version"] != 1
            or not revision
            or {m["market"] for m in cfg["markets"]} != {"CN", "HK", "US"}
        ):
            raise ValueError("unsupported source contract")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('calendar-import',0))")
            old = await (
                await conn.execute(
                    "SELECT original_sha256,original_bytes FROM market_calendar_releases WHERE revision=%s", (revision,)
                )
            ).fetchone()
            if old:
                if old["original_sha256"] != expected_sha or bytes(old["original_bytes"])!=raw:
                    raise ValueError("revision content conflict")
                return revision
            await conn.execute(
                "INSERT INTO market_calendar_releases(revision,schema_version,original_bytes,original_sha256) VALUES(%s,1,%s,%s)",
                (revision, raw, expected_sha),
            )
            for market in cfg["markets"]:
                await conn.execute(
                    "INSERT INTO market_calendar_markets VALUES(%s,%s,%s,%s,%s,%s)",
                    (
                        revision,
                        market["market"],
                        market["name"],
                        market["time_zone"],
                        market["exchanges"],
                        market["verified_years"],
                    ),
                )
            for batch in value["years"]:
                if batch["calendarVersion"] != revision:
                    raise ValueError("mixed revisions")
                for market, cal in batch["calendars"].items():
                    if cal["coverage"]["status"] != "verified":
                        continue
                    year = cal["year"]
                    expected = calendar_unknown(market, year)["days"]
                    if [d["date"] for d in expected] != [d["date"] for d in cal["days"]]:
                        raise ValueError("incomplete annual plan")
                    await conn.execute(
                        "INSERT INTO market_calendar_years VALUES(%s,%s,%s,%s)",
                        (revision, market, year, cal["coverage"]["verifiedAt"]),
                    )
                    for source in cal["sources"]:
                        if not source["url"].startswith("https://"):
                            raise ValueError("invalid source URL")
                        await conn.execute(
                            "INSERT INTO market_calendar_sources VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                            (
                                revision,
                                market,
                                year,
                                source["id"],
                                source["title"],
                                source["url"],
                                source["publishedAt"],
                                source["verifiedAt"],
                            ),
                        )
                    source_ids = {s["id"] for s in cal["sources"]}
                    for day in cal["days"]:
                        expected_day = expected[len([d for d in expected if d["date"] < day["date"]])]
                        status = day["status"]
                        if (
                            day["weekday"] != expected_day["weekday"]
                            or day["isWeekend"] != expected_day["isWeekend"]
                            or status not in ("trading", "weekend", "holiday", "half_day", "unknown")
                            or day["isTradingDay"]
                            != (None if status == "unknown" else status in ("trading", "half_day"))
                            or (status in ("trading", "half_day") and day["isWeekend"])
                            or (status == "weekend" and not day["isWeekend"])
                            or (status == "half_day") != (day["close"] is not None)
                        ):
                            raise ValueError("day status contradiction")
                        if day["actualTradingStatus"] != "unknown" or not set(day["sourceIds"]) <= source_ids:
                            raise ValueError("invalid day provenance")
                        close = day["close"] or {}
                        auction = close.get("auction") or {}
                        await conn.execute(
                            "INSERT INTO market_calendar_days VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (
                                revision,
                                market,
                                day["date"],
                                day["status"],
                                day["name"],
                                day["reason"],
                                close.get("continuous"),
                                auction.get("earliest"),
                                auction.get("latest"),
                                day["sourceIds"],
                            ),
                        )
            await conn.execute(
                "INSERT INTO market_calendar_active(singleton,revision) VALUES(true,%s) ON CONFLICT DO NOTHING",
                (revision,),
            )
            return revision

    async def activate(self, revision, expected):
        async with self.db.connection() as conn, conn.transaction():
            cursor = await conn.execute(
                "UPDATE market_calendar_active SET revision=%s WHERE singleton=true AND revision=%s",
                (revision, expected),
            )
            if cursor.rowcount != 1:
                raise ValueError("calendar publication changed")

    async def discovery(self):
        async with self.db.connection() as conn, conn.transaction():
            release=await(await conn.execute('SELECT r.* FROM market_calendar_active a JOIN market_calendar_releases r ON r.revision=a.revision WHERE a.singleton=true')).fetchone()
            if release is None:return None
            try:original=calendar_release(release)
            except (ValueError,TypeError,KeyError):return None
            rows = await (
                await conn.execute(
                    "SELECT m.* FROM market_calendar_active a JOIN market_calendar_markets m ON m.revision=a.revision ORDER BY m.market"
                )
            ).fetchall()
            try:calendar_markets(original,rows)
            except (ValueError,TypeError,KeyError):return None
            return {
                "path": "/api/v2/market-calendar",
                "batch_path": "/api/v2/market-calendar/batch",
                "api_version": 2,
                "access": "public",
                "schema_version": 1,
                "calendar_version": rows[0]["revision"],
                "markets": [
                    {
                        "market": m["market"],
                        "name": m["name"],
                        "time_zone": m["timezone"],
                        "exchanges": m["exchanges"],
                        "verified_years": m["verified_years"],
                    }
                    for m in rows
                ],
                "temporary_closures": "unknown",
            }

    async def batch(self, year, *, who=None):
        calendar_unknown("US", year)
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            if who is not None:
                from .security import lock_mutation_identity
                await lock_mutation_identity(conn, who, require_admin=False)
            release = await (
                await conn.execute("SELECT r.* FROM market_calendar_active a JOIN market_calendar_releases r ON r.revision=a.revision WHERE a.singleton=true")
            ).fetchone()
            if not release:
                return None
            original=calendar_release(release)
            revision = release["revision"]
            markets = await (
                await conn.execute(
                    "SELECT * FROM market_calendar_markets WHERE revision=%s ORDER BY market", (revision,)
                )
            ).fetchall()
            calendar_markets(original,markets)
            result = {}
            for m in markets:
                market = m["market"]
                unknown = calendar_unknown(market, year)
                verified = await (
                    await conn.execute(
                        "SELECT verified_at FROM market_calendar_years WHERE revision=%s AND market=%s AND year=%s",
                        (revision, market, year),
                    )
                ).fetchone()
                sources = await (
                    await conn.execute(
                        "SELECT * FROM market_calendar_sources WHERE revision=%s AND market=%s AND year=%s ORDER BY source_id",
                        (revision, market, year),
                    )
                ).fetchall()
                days = unknown["days"]
                if verified:
                    rows = await (
                        await conn.execute(
                            "SELECT * FROM market_calendar_days WHERE revision=%s AND market=%s AND day BETWEEN %s AND %s ORDER BY day",
                            (revision, market, date(year, 1, 1), date(year, 12, 31)),
                        )
                    ).fetchall()
                    if len(rows) != len(days):
                        raise ValueError("stored annual plan incomplete")
                    source_ids = {s['source_id'] for s in sources}
                    if not source_ids:
                        raise ValueError('stored annual plan source missing')
                    for day, row in zip(days, rows, strict=True):
                        if (row['day'].isoformat() != day['date']
                                or row['status'] not in ('trading','weekend','holiday','half_day','unknown')
                                or not set(row['source_ids']) <= source_ids
                                or (row['status']=='half_day') != (row['continuous_close'] is not None)
                                or (row['auction_earliest'] is None) != (row['auction_latest'] is None)):
                            raise ValueError('stored annual plan day provenance invalid')
                        day.update(
                            status=row["status"],
                            isTradingDay=None
                            if row["status"] == "unknown"
                            else row["status"] in ("trading", "half_day"),
                            name=row["name"],
                            reason=row["reason"],
                            sourceIds=row["source_ids"],
                        )
                        if row["continuous_close"]:
                            day["close"] = {
                                "continuous": row["continuous_close"],
                                "auction": None
                                if row["auction_earliest"] is None
                                else {
                                    "earliest": row["auction_earliest"],
                                    "latest": row["auction_latest"],
                                    "appliesTo": "CAS_securities",
                                },
                            }
                else:
                    for day in days:
                        day["name"] = None
                result[market] = {
                    "schemaVersion": 1,
                    "calendarVersion": revision,
                    "market": market,
                    "marketName": m["name"],
                    "timeZone": m["timezone"],
                    "year": year,
                    "coverage": {
                        "status": "verified" if verified else "unknown",
                        "from": f"{year}-01-01",
                        "to": f"{year}-12-31",
                        "verifiedYears": m["verified_years"],
                        "exchanges": m["exchanges"],
                        "verifiedAt": verified["verified_at"].isoformat() if verified else None,
                        "basis": "official_annual_schedule",
                        "temporaryClosures": "unknown",
                    },
                    "sources": [
                        {
                            "id": s["source_id"],
                            "title": s["title"],
                            "url": s["url"],
                            "publishedAt": s["published_at"].isoformat() if s["published_at"] else None,
                            "verifiedAt": s["verified_at"].isoformat(),
                        }
                        for s in sources
                    ],
                    "days": days,
                }
            projected={"schemaVersion": 1, "calendarVersion": revision, "year": year, "calendars": result}
            calendar_projection(original,projected)
            return projected
