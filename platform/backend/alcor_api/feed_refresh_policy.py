"""Declared per-person polling intervals over existing licensed feed jobs/pages."""

import hashlib
from datetime import timedelta
from uuid import UUID, uuid5

from fastapi import HTTPException

PEOPLE = {"person-original-json", "trump-archive-html", "xueqiu-status-json"}


async def clock(conn):
    return (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]


def minutes(target):
    value = target.get("refreshMinutes")
    return value if type(value) is int and 1 <= value <= 1440 and target.get("provider") in PEOPLE else None


def effective_interval(sources, job, configured):
    values = [configured]
    for selected in job["inputs"].get("targets", []):
        target = sources.target(job["owner_id"], selected["id"])
        value = minutes(target)
        if value is not None:
            values.append(value)
    return min(values)


async def before_capture(conn, job, target):
    interval = minutes(target)
    if interval is None or job["kind"] != "refresh":
        return None
    from .feed_sources import fingerprint

    latest = await (
        await conn.execute(
            """SELECT a.job_id,p.id,p.received_at,p.complete,p.http_status,p.raw,p.raw_sha256,p.target_fingerprint AS page_fingerprint,r.result FROM feed_source_admissions a
      LEFT JOIN feed_source_pages p USING(owner_id,job_id,target_key) LEFT JOIN feed_source_results r USING(owner_id,job_id,target_key)
      WHERE a.owner_id=%s AND a.target_id=%s AND a.target_fingerprint=%s ORDER BY a.admitted_at DESC LIMIT 1""",
            (job["owner_id"], target["id"], fingerprint(target)),
        )
    ).fetchone()
    if not latest:
        return None
    base = {
        "targetId": target["id"],
        "networkCalled": False,
        "newOriginalStored": False,
        "willRetryAutomatically": False,
        "stage": "refresh_policy",
    }
    state = (latest["result"] or {}).get("state")
    if not latest["id"] or state in (None, "unknown"):
        return {
            **base,
            "state": "unknown",
            "stageState": "blocked_previous_unknown",
            "reason": "previous_admission_outcome_unconfirmed",
            "originalJobId": str(latest["job_id"]),
        }
    if (
        state != "succeeded"
        or latest["complete"] is not True
        or latest["http_status"] != 200
        or latest["page_fingerprint"] != fingerprint(target)
        or hashlib.sha256(bytes(latest["raw"])).hexdigest() != latest["raw_sha256"]
    ):
        return {
            **base,
            "state": "unavailable",
            "stageState": "previous_capture_not_known_success",
            "reason": "explicit_source_reconciliation_required",
        }
    due = latest["received_at"] + timedelta(minutes=interval)
    if await clock(conn) < due:
        return {
            **base,
            "state": "succeeded",
            "stageState": "not_due",
            "reason": "retained_previous_original_not_new_capture",
            "count": 0,
            "added": 0,
            "nextSourceAt": due.isoformat(),
            "retainedPageId": str(latest["id"]),
            "retainedObservedAt": latest["received_at"].isoformat(),
        }
    return None


async def enroll_changed(conn, db, who, parent_id, values):
    """Saving explicit person intervals refreshes an already-enabled owner group only."""
    from .feed_core import group_on_connection, preferences_on_connection
    from .feed_sources import FeedSources
    from .market_worker import Bound
    from .private_runtime_settings import apply_group

    settings = db.settings.model_copy(deep=False)
    apply_group(settings, "sources", values)
    service = FeedSources(Bound(conn, settings))
    outcomes = []
    groups = await (
        await conn.execute(
            "SELECT id FROM feed_groups WHERE owner_id=%s AND mode='people' ORDER BY id LIMIT 12", (who.id,)
        )
    ).fetchall()
    for entry in groups:
        group = await group_on_connection(conn, who.id, entry["id"])
        prefs = await preferences_on_connection(conn, who.id, entry["id"])
        if not prefs["enabled"]:
            continue
        rid = str(uuid5(UUID(str(parent_id)), "people-refresh-interval:" + entry["id"]))
        try:
            outcome = await service.refresh(
                who,
                {
                    "requestId": rid,
                    "groupId": entry["id"],
                    "groupRevision": group["revision"],
                    "scheduled": True,
                },
            )
        except HTTPException as error:
            outcome = {"state": "unavailable", "reason": str(error.detail), "networkCalled": False}
        outcomes.append({"groupId": entry["id"], "operation": outcome})
    return outcomes
