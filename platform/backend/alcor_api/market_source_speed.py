"""Rank currently licensed quote sources from recent market-specific observations."""

from collections import defaultdict
from datetime import timedelta
from statistics import median

PROVIDERS = ("futu", "tencent", "eastmoney", "yahoo")
MAX_QUOTE_AGE = timedelta(seconds=90)


async def read_samples(conn, owner):
    rows = await (await conn.execute(
        """SELECT tests.source_revision, tests.result
           FROM unnest(%s::text[]) provider(name)
           CROSS JOIN LATERAL (
               SELECT r.source_revision, r.result
               FROM market_source_tests r
               JOIN market_source_configs c ON c.owner_id=r.owner_id AND c.revision=r.source_revision
                   AND c.policy_fingerprint=r.policy_fingerprint
               WHERE r.owner_id=%s AND r.provider=provider.name AND r.result IS NOT NULL
                 AND r.created_at>clock_timestamp()-interval '24 hours'
               ORDER BY r.created_at DESC,r.request_id DESC LIMIT 5
           ) tests""", (list(PROVIDERS), owner),
    )).fetchall()
    samples = defaultdict(list)
    for row in rows:
        for market, result in (row["result"].get("markets") or {}).items():
            latency = result.get("elapsedMs")
            session = result.get("session") or result.get("requestedSession")
            if result.get("state") == "available" and result.get("sourceTime") and type(latency) is int and 0 <= latency <= 60_000:
                samples[row["source_revision"], market, session].append(latency)
            elif result.get("state") == "unavailable":
                samples[row["source_revision"], market, result.get("requestedSession") or "REGULAR"].append(None)
    return samples


def score(samples, revision, market, session):
    values = samples.get((revision, market, session or "REGULAR"), ())
    successful = [value for value in values if value is not None]
    if len(successful) < 2 or len(successful) / len(values) < 0.6:
        return None
    return 1 - len(successful) / len(values), median(successful)


def choose_manual_quote(candidates, order, now):
    rank = {provider: index for index, provider in enumerate(order)}
    eligible = [item for item in candidates if item[1].source in rank]
    if not eligible:
        return None
    fresh = [item for item in eligible
             if -timedelta(seconds=5) <= now - item[0]["source_time"] <= MAX_QUOTE_AGE
             and item[2].get("cached") is not True]
    if fresh:
        chosen = max(fresh, key=lambda item: (-rank[item[1].source], item[0]["source_time"], -item[0]["sequence"]))
    else:
        chosen = max(eligible, key=lambda item: (item[0]["source_time"], -rank[item[1].source], -item[0]["sequence"]))
    return chosen[0]["source_revision"]


def choose_quote(candidates, samples, market, now, existing=None):
    """Choose a valid source without waiting for an absent competitor."""
    eligible = [item for item in candidates if item[1].source in PROVIDERS]
    if not eligible:
        return None
    fresh = [item for item in eligible if -timedelta(seconds=5) <= now - item[0]["source_time"] <= MAX_QUOTE_AGE
             and item[2].get("session") != "UNKNOWN" and item[2].get("cached") is not True]
    if not fresh:
        # For retained or closed-session quotes, keep the latest actual observation.
        return max(eligible, key=lambda item: (item[0]["source_time"], -item[0]["sequence"]))[0]["source_revision"]
    newest = max(item[0]["source_time"] for item in fresh)
    fresh = [item for item in fresh if newest - item[0]["source_time"] <= timedelta(seconds=20)]
    scored = []
    for item in fresh:
        fact, _, quote, _ = item
        rank = score(samples, fact["source_revision"], market, quote.get("session"))
        if rank is not None:
            scored.append((rank, fact["sequence"], fact["source_revision"]))
    if scored:
        return min(scored)[2]
    if existing is not None and any(item[0]["source_revision"] == existing for item in fresh):
        return existing
    # Sequence is database admission order for already arrived provider facts.
    return min(fresh, key=lambda item: item[0]["sequence"])[0]["source_revision"]
