"""Public disclosed return observations, never a fabricated celebrity account ledger.

The former client's five-year synthetic interpolation is intentionally excluded.
Undated reported percentages remain reported percentages, not daily observations.
"""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException


def exact(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        return format(number, "f") if number.is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def observed_series(raw):
    if not isinstance(raw, dict):
        return [], [], [], ["dated_return_observations_missing"]
    dates = raw.get("dates")
    values = raw.get("values")
    if (
        not isinstance(dates, list)
        or not isinstance(values, list)
        or len(dates) != len(values)
        or len(dates) > 10000
    ):
        return [], [], [], ["dated_return_observations_missing"]
    result_dates = []
    result_values = []
    indices = []
    reasons = []
    for index, (day, value) in enumerate(zip(dates, values, strict=True)):
        try:
            parsed = date.fromisoformat(day)
            if (
                parsed.isoformat() != day
                or parsed > date.today()
                or (result_dates and day <= result_dates[-1])
            ):
                raise ValueError()
        except (ValueError, TypeError):
            reasons.append("invalid_or_unordered_observation_date")
            continue
        indices.append(index)
        result_dates.append(day)
        result_values.append(exact(value))
    if any(value is None for value in result_values):
        reasons.append("return_observation_value_unknown")
    benches = []
    for bench in raw.get("benchmarks", []) if isinstance(raw.get("benchmarks", []), list) else []:
        if not isinstance(bench, dict) or not isinstance(bench.get("code"), str):
            continue
        vals = bench.get("values")
        if not isinstance(vals, list) or len(vals) != len(dates):
            continue
        projected = [exact(vals[index]) for index in indices]
        benches.append(
            {
                "code": bench["code"],
                "name": bench.get("name") or bench["code"],
                "values": projected,
                "state": "observed" if all(v is not None for v in projected) else "partial",
                "provenance": {
                    "authority": "published_return_observation",
                    "source": bench.get("source") or raw.get("source"),
                    "sourceUrl": bench.get("sourceUrl") or raw.get("sourceUrl"),
                },
            }
        )
    return result_dates, result_values, benches, list(dict.fromkeys(reasons))


class CelebReturns:
    def __init__(self, db, authority=None):
        self.db, self.authority = db, authority

    async def read(self, celeb_id):
        from .celeb_core import latest_on_connection

        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            row = await latest_on_connection(conn, celeb_id, public=True)
            if not row:
                raise HTTPException(404, "名人资料不存在")
            from .celeb_evidence import source_integrity
            integrity=await source_integrity(conn,row)
            payload = row["payload"]
            raw = payload.get("returns") or {}
            if not isinstance(raw, dict):
                raw = {}
            evidence = payload.get("sourceEvidence") or {}
            sample = (
                payload.get("sample") is True
                or payload.get("sourceKind") == "sample"
                or row.get("source_kind") == "sample"
            )
            dates, values, benchmarks, reasons = observed_series(raw)
            # A persisted public catalogue revision proves publication, not that
            # an interpolated or undated chart was ever actually observed.
            source = raw.get("source") or raw.get("sourceUrl") or raw.get("sourcePageId")
            if dates and not source:
                dates, values, benchmarks = [], [], []
                reasons.append("return_series_source_evidence_missing")
            if integrity['state']=='retained_unavailable':
                dates,values,benchmarks=[],[],[]
                reasons.append('disclosure_original_integrity_unavailable')
            if raw.get("synthetic") is True or raw.get("syntheticHistory") is True:
                dates, values, benchmarks = [], [], []
                reasons.append("synthetic_return_history_not_used")
            summary = {key: exact(raw.get(key)) for key in ("y1", "y3", "y5", "spxY1")}
            if not dates:
                reasons.append("actual_portfolio_history_not_registered")
            return {
                "dates": dates,
                "values": values,
                "benchmarks": benchmarks,
                "state": "sample"
                if sample
                else "partial"
                if dates and reasons
                else "observed"
                if dates
                else "unknown",
                "disclosedSummary": summary,
                "disclosedSummaryAuthority": "sample_declaration"
                if sample
                else "published_declaration_not_independently_verified",
                "provenance": {
                    "celebId": celeb_id,
                    "revision": row["revision"],
                    "source": source,
                    "sourceKind": payload.get("sourceKind") or row.get("source_kind"),
                    "sourcePageId": row.get("source_page_id"),
                    "sourceRevision": row.get("source_revision"),
                    "observedAt": raw.get("observedAt"),
                    "registeredAt": row["created_at"].isoformat()
                    if isinstance(row.get("created_at"), datetime)
                    else row.get("created_at"),
                    "sourceEvidence": evidence,
                    "sourceIntegrity": integrity,
                },
                "unknownReasons": list(dict.fromkeys(reasons)),
                "syntheticHistory": False,
                "portfolioPerformanceKnown": False,
                "calculation": {
                    "method": "published_dated_return_observations",
                    "holdingsBackfilled": False,
                    "privateOwnerMarketDataUsed": False,
                    "collectionOnRead": False,
                    "currency": raw.get("currency"),
                    "startBasis": raw.get("startBasis"),
                },
            }
