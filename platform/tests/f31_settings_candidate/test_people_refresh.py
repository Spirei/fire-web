"""Declared people cooldown uses real immutable feed evidence, with controlled IO only."""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from alcor_api import feed_refresh_policy as policy
from alcor_api.feed_sources import fingerprint
from alcor_api.feed_transport import FeedTransport, Response
from alcor_api.feed_worker import FeedWorker
from alcor_api.worker import claim


def installed(db, owner, person, interval):
    return {
        "id": person,
        "ownerId": owner,
        "instanceId": str(db.settings.instance_id),
        "provider": "person-original-json",
        "purpose": "feed.person.read",
        "personId": person,
        "url": "https://example.com/" + person,
        "approvedAccess": True,
        "addresses": ["93.184.216.34"],
        "licenseRevision": "synthetic-people",
        "expiresAt": "2099-01-01T00:00:00+00:00",
        "refreshMinutes": interval,
    }


async def run_one(db):
    task = await claim(db, uuid4())
    assert task
    await FeedWorker(db).execute(task)
    async with db.connection() as conn:
        job = await (
            await conn.execute("SELECT * FROM feed_source_jobs WHERE task_id=%s", (task["id"],))
        ).fetchone()
        results = await (
            await conn.execute(
                "SELECT result FROM feed_source_results WHERE job_id=%s ORDER BY target_key", (job["id"],)
            )
        ).fetchall()
    return job, [row["result"] for row in results]


async def create(client):
    response = await client.post(
        "/api/feed/groups",
        json={
            "requestId": str(uuid4()),
            "name": "Synthetic people",
            "mode": "people",
            "people": ["trump", "duan"],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]["id"]


def transport(monkeypatch, calls, *, unknown=False):
    async def read(self, target, *, params=None):
        calls.append(target["id"])
        if unknown:
            raise TimeoutError("controlled unconfirmed outcome")
        person = target["personId"]
        base = (
            "https://truthsocial.com/@realDonaldTrump/"
            if person == "trump"
            else "https://xueqiu.com/1247347556/"
        )
        raw = json.dumps(
            {
                "posts": [
                    {
                        "id": "10000",
                        "text": "Synthetic observed original",
                        "date": "2026-10-01T12:00:00+00:00",
                        "originalUrl": base + "10000",
                    }
                ]
            }
        ).encode()
        return Response(raw, 200)

    monkeypatch.setattr(FeedTransport, "read", read)


async def totals(db):
    async with db.connection() as conn:
        return [
            (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"]
            for table in ("feed_source_admissions", "feed_source_pages", "feed_posts")
        ]


async def test_people_distinct_intervals_due_one_io_and_not_due_no_new_evidence(
    client, db, admin, monkeypatch
):
    db.settings.feed_targets = [installed(db, admin, "trump", 2), installed(db, admin, "duan", 10)]
    calls = []
    transport(monkeypatch, calls)
    gid = await create(client)
    job, results = await run_one(db)
    assert job["status"] == "succeeded" and sorted(calls) == ["duan", "trump"], results
    assert policy.effective_interval(FeedWorker(db).sources, job, 5) == 2
    before = await totals(db)
    # A separate explicit refresh cannot bypass the current target cooldown.
    raw = {"requestId": str(uuid4()), "groupId": gid, "groupRevision": job["group_revision"]}
    response = await client.post("/api/feed/refresh", json=raw)
    assert response.status_code == 200, response.text
    _, results = await run_one(db)
    assert all(
        row["stageState"] == "not_due" and row["newOriginalStored"] is False and row["nextSourceAt"]
        for row in results
    )
    assert await totals(db) == before and len(calls) == 2

    async def later(conn):
        return datetime.now(UTC) + timedelta(minutes=3)

    monkeypatch.setattr(policy, "clock", later)
    worker = FeedWorker(db)
    assert await worker.schedule() == 1
    _, results = await run_one(db)
    assert calls == ["duan", "trump", "trump"] or calls == ["trump", "duan", "trump"]
    assert next(row for row in results if row["targetId"] == "duan")["stageState"] == "not_due"
    assert next(row for row in results if row["targetId"] == "trump")["state"] == "succeeded"
    after = await totals(db)
    assert after[:2] == [before[0] + 1, before[1] + 1] and after[2] == before[2]


async def test_people_current_target_change_revoke_disabled_and_missing_no_new_io(
    client, db, admin, monkeypatch
):
    current = installed(db, admin, "trump", 2)
    db.settings.feed_targets = [current]
    calls = []
    transport(monkeypatch, calls)
    gid = await create(client)
    job, _ = await run_one(db)
    before = await totals(db)
    # A changed explicit target declaration has a new independent fingerprint.
    old = fingerprint(current)
    current["licenseRevision"] = "synthetic-people-v2"
    assert fingerprint(current) != old
    response = await client.post(
        "/api/feed/refresh",
        json={"requestId": str(uuid4()), "groupId": gid, "groupRevision": job["group_revision"]},
    )
    assert response.status_code == 200, response.text
    # Revocation between queueing and admission is authoritative: no new IO/page.
    current["approvedAccess"] = False
    _, results = await run_one(db)
    assert results[0]["state"] == "unavailable" and results[0]["networkCalled"] is False
    assert len(calls) == 1 and await totals(db) == before
    assert await FeedWorker(db).schedule() == 0
    current["approvedAccess"] = True
    response = await client.post(
        "/api/feed/refresh",
        json={"requestId": str(uuid4()), "groupId": gid, "groupRevision": job["group_revision"]},
    )
    assert response.status_code == 200, response.text
    _, results = await run_one(db)
    assert results[0]["state"] == "succeeded" and len(calls) == 2
    assert (await totals(db))[:2] == [before[0] + 1, before[1] + 1]
    response = await client.put(
        "/api/feed/preferences?group=" + gid,
        json={
            "requestId": str(uuid4()),
            "revision": job["group_revision"],
            "instructions": "",
            "enabled": False,
        },
    )
    assert response.status_code == 200, response.text
    assert await FeedWorker(db).schedule() == 0
    async with db.connection() as conn:
        groups = (
            await (
                await conn.execute("SELECT count(*) n FROM feed_groups WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"]
    assert await FeedWorker(db).schedule() == 0
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM feed_groups WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == groups


async def test_people_prior_unknown_admission_never_reissued_even_new_request(client, db, admin, monkeypatch):
    db.settings.feed_targets = [installed(db, admin, "trump", 2)]
    calls = []
    transport(monkeypatch, calls, unknown=True)
    gid = await create(client)
    job, results = await run_one(db)
    assert job["status"] == "unknown" and results[0]["state"] == "unknown" and calls == ["trump"]
    before = await totals(db)
    transport(monkeypatch, calls)
    response = await client.post(
        "/api/feed/refresh",
        json={"requestId": str(uuid4()), "groupId": gid, "groupRevision": job["group_revision"]},
    )
    assert response.status_code == 200, response.text
    _, results = await run_one(db)
    assert results[0]["stageState"] == "blocked_previous_unknown"
    assert results[0]["willRetryAutomatically"] is False
    assert calls == ["trump"] and await totals(db) == before
    assert await FeedWorker(db).schedule() == 0
