"""Recover optional metrics only from the immutable SDK page that created this exact fact."""

import json
from dataclasses import asdict
from datetime import datetime
from decimal import Decimal

from .dividend_sources import security
from .fx_provider_parser import unique
from .market_contract import CURRENCIES, ZONES, digest, number, source_time


class SnapshotMetricMismatch(ValueError):
    pass


async def with_snapshot_metrics(conn, who, query, policy, fact, cache):
    value = fact["contents"]
    if policy.source != "futu" or policy.source_version != "futu-sdk-records-v1":
        return fact
    if type(value.get("snapshotMetricsVersion")) is int and value["snapshotMetricsVersion"] in (1, 2):
        return fact
    key = (str(fact["page_id"]), digest(asdict(query)))
    if key not in cache:
        page = await (
            await conn.execute(
                """SELECT raw_bytes,raw_sha256,representation FROM market_source_pages
            WHERE owner_id=%s AND id=%s AND source_revision=%s""",
                (who.id, fact["page_id"], fact["source_revision"]),
            )
        ).fetchone()
        if not page:
            raise SnapshotMetricMismatch("source_page_missing")
        if page["representation"] != "sdk_json_representation_not_wire_bytes":
            cache[key] = None
        else:
            raw = bytes(page["raw_bytes"])
            if digest(raw) != page["raw_sha256"]:
                raise SnapshotMetricMismatch("source_page_digest_mismatch")
            from .market_worker import decode

            try:
                rows, _, _ = decode(policy, query, raw)
            except (ValueError, TypeError, KeyError, OverflowError):
                rows = []
            cache[key] = (rows, raw)
    entry = cache[key]
    if entry is None:
        return {**fact, "snapshot_metrics_unavailable": "original_representation_not_supported"}
    rows, raw = entry
    matched = [
        row
        for row in rows
        if row.get("at") == value.get("at")
        and all(
            name in row and type(row[name]) is type(original) and row[name] == original
            for name, original in value.items() if name not in {"cached", "session"}
        )
    ]
    if len(matched) != 1:
        # F15 no longer asserts an uncached/current session from an ordinary SDK
        # snapshot. That change must not erase an older genuine observation.
        # Verify its actual source identity/price/time without inventing metrics.
        if query.kind != "latest":
            raise SnapshotMetricMismatch("source_page_fact_mismatch")
        try:
            payload=json.loads(raw,object_pairs_hook=unique,parse_float=Decimal,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            records=payload.get("records") if isinstance(payload,dict) else None
            if not isinstance(records,list) or len(records)>1000:
                raise ValueError()
            symbol=security("futu",query.market,query.code)
            verified=[]
            for source in records:
                if not isinstance(source,dict) or source.get("code")!=symbol:
                    continue
                at=source_time(source.get("update_time"),ZONES[query.market])
                if (at==fact["source_time"] and at==datetime.fromisoformat(value["at"])
                        and number(source.get("last_price"),positive=True)==number(value["price"],positive=True)
                        and value.get("source")==policy.source and value.get("sourceVersion")==policy.source_version
                        and value.get("currency")==CURRENCIES[query.market]):
                    verified.append(source)
            if len(verified)!=1:
                raise ValueError()
        except (ValueError,TypeError,KeyError,OverflowError) as exc:
            raise SnapshotMetricMismatch("source_page_fact_mismatch") from exc
        return {**fact,"snapshot_metrics_unavailable":"legacy_normalizer_declarations_differ",
                "legacy_snapshot_observation_verified":True}
    # Preserve UUID, sequence, source time, old values and stored history; this is a read projection only.
    contents = {**matched[0], **value}
    return {**fact, "contents": contents, "snapshot_metrics_recovered": True}
