"""Leased, admitted SEC collection. Missing responses are never requested twice."""

import copy
import hashlib
import json
import re
from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .celeb_sec_parse import filings, parse_xml
from .celeb_sources import CelebSources, SecRequest, fingerprint
from .feed_worker import FeedWorker
from .sec_company_transport import PageFailure, Transport


class UnknownOutcome(ValueError):
    pass


class CelebSourceWorker:
    def __init__(self, db):
        self.db = db
        self._schedule_cursor = None
        self.sources = CelebSources(db)
        self.transport = Transport()
        self.pulse = FeedWorker(db).pulse

    async def active(self, conn, job):
        subject = job["subject"]
        if subject["instanceId"] != str(self.db.settings.instance_id):
            raise HTTPException(409, "恢复实例已换代")
        from .fx_reference import external_delivery_blocked

        if await external_delivery_blocked(conn):
            raise HTTPException(409, "恢复实例尚未授权外部采集")
        row = await (
            await conn.execute(
                "SELECT u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND u.active AND u.deleted_at IS NULL AND u.role='admin' AND s.token_hash=%s AND s.client_id=ANY(%s) AND s.session_version=u.session_version AND u.session_version=%s AND s.expires_at>clock_timestamp()",
                (
                    job["owner_id"],
                    subject["sessionHash"],
                    ["new-web", "legacy-web"],
                    subject["sessionVersion"],
                ),
            )
        ).fetchone()
        if not row:
            raise HTTPException(403, "采集管理员会话已失效")
        target = self.sources.target(job["owner_id"], job["target_id"])
        if fingerprint(target) != job["target_fingerprint"]:
            raise HTTPException(409, "来源配置已变化")
        from .celeb_core import latest_on_connection

        current = await latest_on_connection(conn, job["celeb_id"], False)
        if not current or current["revision"] != job["revision"]:
            raise HTTPException(409, "名人来源修订已变化")
        return target

    async def lock(self, conn, task):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            ("identity-management:" + task["owner_id"],),
        )
        from .worker import owned_row

        owned = await owned_row(conn, task)
        if not owned:
            raise UnknownOutcome("lease_lost")
        if owned["status"] == "cancel_requested":
            raise HTTPException(409, "采集已请求停止")

    async def page(self, task, job, url):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, task)
            target = copy.deepcopy(await self.active(conn, job))
            SecRequest(target, url).request()
            prior = await (
                await conn.execute(
                    "SELECT * FROM celeb_source_pages WHERE owner_id=%s AND job_id=%s AND url=%s",
                    (job["owner_id"], job["id"], url),
                )
            ).fetchone()
            if prior:
                return self.checked(prior)
            admitted = await (
                await conn.execute(
                    "SELECT 1 FROM celeb_source_admissions WHERE owner_id=%s AND job_id=%s AND url=%s",
                    (job["owner_id"], job["id"], url),
                )
            ).fetchone()
            if admitted:
                raise UnknownOutcome("admitted_page_outcome_unconfirmed")
            budget = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM celeb_source_admissions WHERE owner_id=%s AND job_id=%s",
                    (job["owner_id"], job["id"]),
                )
            ).fetchone()
            if budget["n"] >= 24:
                raise ValueError("sec_page_budget")
            await conn.execute(
                "INSERT INTO celeb_source_admissions(owner_id,job_id,url,target_fingerprint,license_revision) VALUES(%s,%s,%s,%s,%s)",
                (job["owner_id"], job["id"], url, job["target_fingerprint"], target["licenseRevision"]),
            )
        try:
            raw = await self.pulse(task, lambda: self.transport.read(SecRequest(target, url)))
            status, complete = 200, True
        except PageFailure as exc:
            raw, status, complete = exc.raw, exc.status, exc.complete
        except Exception as exc:
            raise UnknownOutcome("admitted_page_outcome_unconfirmed") from exc
        # Issued requests retain their observed bytes independently of a later
        # actor/lease/licence change. Only publication requires a live actor.
        complete=bool(complete and len(raw)<=8388608)
        raw=bytes(raw[:8388608])
        async with self.db.connection() as conn, conn.transaction():
            instance=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
            bound=await(await conn.execute('SELECT j.*,a.target_fingerprint AS admitted_fingerprint,a.license_revision FROM celeb_source_jobs j JOIN celeb_source_admissions a ON a.owner_id=j.owner_id AND a.job_id=j.id WHERE j.owner_id=%s AND j.id=%s AND a.url=%s',(job['owner_id'],job['id'],url))).fetchone()
            if (not instance or str(instance['instance_id'])!=job['subject']['instanceId'] or str(self.db.settings.instance_id)!=job['subject']['instanceId']
                    or not bound or bound['task_id']!=task['id'] or bound['subject']!=job['subject'] or bound['celeb_id']!=job['celeb_id']
                    or bound['target_fingerprint']!=job['target_fingerprint'] or bound['admitted_fingerprint']!=fingerprint(target)
                    or bound['license_revision']!=target['licenseRevision']):
                raise UnknownOutcome('received_page_origin_binding_changed')
            row = await (
                await conn.execute(
                    "INSERT INTO celeb_source_pages(owner_id,id,job_id,url,raw,raw_sha256,http_status,complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING *",
                    (
                        job["owner_id"],
                        uuid4(),
                        job["id"],
                        url,
                        raw,
                        hashlib.sha256(raw).hexdigest(),
                        status,
                        complete,
                    ),
                )
            ).fetchone()
            if row is None:
                row = await (
                    await conn.execute(
                        "SELECT * FROM celeb_source_pages WHERE owner_id=%s AND job_id=%s AND url=%s",
                        (job["owner_id"], job["id"], url),
                    )
                ).fetchone()
        return self.checked(row)

    def checked(self, page):
        raw = bytes(page["raw"])
        if hashlib.sha256(raw).hexdigest() != page["raw_sha256"]:
            raise ValueError("sec_original_sha_mismatch")
        if not page["complete"]:
            raise ValueError("sec_original_page_incomplete")
        if page["http_status"] != 200:
            if page["http_status"] >= 500:
                raise UnknownOutcome("sec_http_unavailable")
            raise ValueError("sec_http_rejected")
        return page

    async def filing(self, task, job, target, filing):
        cik = target["cik"]
        accession = filing["accessionNumber"].replace("-", "")
        base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession}/"
        candidates = []
        pages = []
        primary = filing.get("primaryDocument")
        if isinstance(primary, str):
            name = primary.rsplit("/", 1)[-1]
            if re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                candidates.append(name)
        if target["sourceKind"] == "13f":
            index = await self.page(task, job, base + "index.json")
            pages.append(str(index["id"]))
            directory = json.loads(bytes(index["raw"])).get("directory", {}).get("item", [])
            if not isinstance(directory, list) or len(directory) > 10000:
                raise ValueError("sec_directory_budget")
            names = [v.get("name") for v in directory if isinstance(v, dict)]
            candidates = [
                v
                for v in names
                if isinstance(v, str)
                and re.fullmatch(r"[A-Za-z0-9_.-]+", v)
                and ("infotable" in v.lower() or v.lower().endswith(".xml"))
            ] + candidates
        for name in list(dict.fromkeys(candidates))[:6]:
            try:
                page = await self.page(task, job, base + name)
                pages.append(str(page["id"]))
                parsed = parse_xml(bytes(page["raw"]), target["sourceKind"])
                return parsed, page, {**filing, "documentUrl": base + name, "pageIds": pages}
            except UnknownOutcome:
                raise
            except (ValueError, TypeError):
                continue
        raise ValueError("no_usable_filing_document")

    async def schedule(self, limit=100):
        """Explicit consent only; known successful child revision is the next CAS."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("celeb_schedule_budget")
        async with self.db.connection() as conn:
            rows = await (
                await conn.execute(
                    """SELECT * FROM (SELECT DISTINCT ON(owner_id,celeb_id) * FROM celeb_source_jobs ORDER BY owner_id,celeb_id,created_at DESC,id DESC) heads WHERE inputs->>'scheduled'='true' AND result->>'state'='completed' AND (%s::text IS NULL OR (owner_id,celeb_id)>(%s,%s)) ORDER BY owner_id,celeb_id LIMIT %s""",
                    (
                        self._schedule_cursor[0] if self._schedule_cursor else None,
                        self._schedule_cursor[0] if self._schedule_cursor else "",
                        self._schedule_cursor[1] if self._schedule_cursor else "",
                        limit,
                    ),
                )
            ).fetchall()
        if not rows:
            self._schedule_cursor = None
        added = 0
        for base in rows:
            self._schedule_cursor = (base["owner_id"], base["celeb_id"])
            async with self.db.connection() as conn, conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    ("identity-management:" + base["owner_id"],),
                )
                latest = await (
                    await conn.execute(
                        "SELECT j.*,t.status AS task_status,t.finished_at AS task_finished_at FROM celeb_source_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.owner_id=%s AND j.celeb_id=%s ORDER BY j.created_at DESC,j.id DESC LIMIT 1",
                        (base["owner_id"], base["celeb_id"]),
                    )
                ).fetchone()
                if (
                    not latest
                    or latest["id"] != base["id"]
                    or latest["task_status"] != "succeeded"
                    or not latest["result"]
                    or latest["result"].get("state") != "completed"
                    or not latest["task_finished_at"]
                ):
                    continue
                success_revision = latest["result"].get("result", {}).get("revision")
                if type(success_revision) is not int:
                    continue
                candidate = {**base, "revision": success_revision}
                try:
                    target = await self.active(conn, candidate)
                except (HTTPException, ValueError, TypeError):
                    continue
                from .celeb_core import latest_on_connection

                current = await latest_on_connection(conn, base["celeb_id"], False)
                payload = current["payload"]
                interval = base["inputs"].get("refreshHours")
                if (
                    payload.get("enabled") is not True
                    or not isinstance(interval, (int, float))
                    or interval <= 0
                    or payload.get("refreshHours") != interval
                    or payload.get("cik") != target["cik"]
                    or payload.get("sourceKind") != target["sourceKind"]
                ):
                    continue
                now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
                if now < latest["task_finished_at"] + timedelta(hours=interval):
                    continue
                count = await (
                    await conn.execute(
                        "SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",
                        (base["owner_id"],),
                    )
                ).fetchone()
                if count["n"] >= 100:
                    continue
                rid = uuid5(UUID(base["inputs"]["scheduleRoot"]), "scheduled-after:" + str(base["id"]))
                if await (
                    await conn.execute(
                        "SELECT 1 FROM tasks WHERE owner_id=%s AND request_id=%s", (base["owner_id"], rid)
                    )
                ).fetchone():
                    continue
                jid, tid = uuid4(), uuid4()
                inputs = {**base["inputs"], "previousJobId": str(base["id"])}
                hashed = fingerprint(
                    {
                        "parent": str(base["request_id"]),
                        "revision": success_revision,
                        "target": base["target_fingerprint"],
                    }
                )
                await conn.execute(
                    "INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'celeb.sec_collect','queued',%s)",
                    (tid, base["owner_id"], rid, hashed, Jsonb({"celebJobId": str(jid)})),
                )
                await conn.execute(
                    "INSERT INTO celeb_source_jobs(owner_id,id,request_id,task_id,celeb_id,revision,target_id,target_fingerprint,subject,request_hash,inputs) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        base["owner_id"],
                        jid,
                        rid,
                        tid,
                        base["celeb_id"],
                        success_revision,
                        base["target_id"],
                        base["target_fingerprint"],
                        Jsonb(base["subject"]),
                        hashed,
                        Jsonb(inputs),
                    ),
                )
                await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (tid,))
                added += 1
        return added

    async def execute(self, task):
        from .worker import finish

        async with self.db.connection() as conn:
            job = await (
                await conn.execute(
                    "SELECT * FROM celeb_source_jobs WHERE owner_id=%s AND task_id=%s",
                    (task["owner_id"], task["id"]),
                )
            ).fetchone()
        if not job:
            return await finish(self.db, task, {"state": "unknown"}, error_code="celeb_job_missing")
        if job["result"]:
            return await finish(
                self.db,
                task,
                job["result"],
                error_code=None
                if job["result"]["state"] == "completed"
                else "celeb_source_" + job["result"]["state"],
            )
        try:
            async with self.db.connection() as conn, conn.transaction():
                await self.lock(conn, task)
                target = await self.active(conn, job)
            submission = await self.page(
                task, job, f"https://data.sec.gov/submissions/CIK{target['cik']}.json"
            )
            selected = filings(bytes(submission["raw"]), target["cik"], target["sourceKind"])
            observed = []
            failures = []
            for filing in selected[: 2 if target["sourceKind"] == "13f" else 8]:
                try:
                    parsed, page, evidence = await self.filing(task, job, target, filing)
                    observed.append((parsed, page, evidence))
                    if len(observed) == 2:
                        break
                except UnknownOutcome:
                    raise
                except (ValueError, TypeError):
                    failures.append(filing["accessionNumber"])
            if not observed:
                raise ValueError("no_usable_reported_holdings")
            latest, page, evidence = observed[0]
            # Full original rows are retained as filing evidence. Only fields
            # understood by the shared catalogue enter its public projection.
            allowed = {
                "code",
                "name",
                "market",
                "quantity",
                "cusip",
                "putCall",
                "valueReported",
                "valueUnit",
                "sharesType",
                "weight",
                "weightDelta",
                "price",
                "cost",
                "currency",
            }
            holdings = [{k: v for k, v in h.items() if k in allowed} for h in latest["holdings"]]
            for h in holdings:
                h["market"] = None
            trades = [
                {
                    "code": r.get("code") or "",
                    "name": r.get("name") or "",
                    "market": None,
                    "action": r.get("transactionCode") or "",
                    "quantity": r.get("quantity"),
                    "price": r.get("price"),
                    "date": r.get("date"),
                    "currency": None,
                    "sourceUrl": evidence["documentUrl"],
                }
                for r in latest["trades"]
            ]
            changes = {
                "holdings": holdings,
                "trades": trades,
                "reportDate": evidence.get("reportDate") or None,
                "sourceUrl": evidence["documentUrl"],
                "sourceEvidence": {
                    "provider": "SEC EDGAR",
                    "cik": target["cik"],
                    "licenseRevision": target["licenseRevision"],
                    "targetId": target["id"],
                    "filings": [v[2] for v in observed],
                    "submissionPageId": str(submission["id"]),
                    "reportedRowsAuthority": "referenced_immutable_sec_xml_pages",
                    "coverage": {
                        "state": "observed_filings_only",
                        "wholePortfolioKnown": False,
                        "previousFilingKnown": len(observed) > 1,
                        "unparsedAccessions": failures,
                        "submissionsRecentOnly": True,
                    },
                    "unitsAuthority": "original_filing_value_unscaled",
                    "valueUnitKnown": False,
                },
            }
            async with self.db.connection() as conn, conn.transaction():
                await self.lock(conn, task)
                await self.active(conn, job)
                from .celeb_core import Celebs

                who = SimpleNamespace(
                    id=job["owner_id"],
                    role="admin",
                    token_hash=job["subject"]["sessionHash"],
                    native_client=False,
                    legacy_client=job["subject"].get("sessionClient") == "legacy-web",
                )
                child = str(uuid5(UUID(str(job["request_id"])), "sec-catalogue:" + page["raw_sha256"]))
                result = await Celebs(self.db).ingest_on_connection(
                    conn,
                    who,
                    job["celeb_id"],
                    job["revision"],
                    changes,
                    source_revision=job["target_fingerprint"],
                    source_page_id=str(page["id"]),
                    request_id=child,
                )
                output = {
                    "state": "partial" if failures else "completed",
                    "requestId": str(job["request_id"]),
                    "childRequestId": child,
                    "result": result,
                    "sourcePageId": str(page["id"]),
                    "observedFilings": len(observed),
                    "willRetryAutomatically": False,
                }
                await conn.execute(
                    "UPDATE celeb_source_jobs SET result=%s WHERE owner_id=%s AND id=%s AND result IS NULL",
                    (Jsonb(output), job["owner_id"], job["id"]),
                )
        except UnknownOutcome:
            output = {
                "state": "unknown",
                "requestId": str(job["request_id"]),
                "reason": "admitted_source_outcome_unconfirmed",
                "willRetryAutomatically": False,
            }
        except (HTTPException, ValueError, TypeError, KeyError):
            output = {
                "state": "unavailable",
                "requestId": str(job["request_id"]),
                "reason": "source_authorization_revision_or_document_unavailable",
                "originalsRetained": True,
                "willRetryAutomatically": False,
            }
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "UPDATE celeb_source_jobs SET result=%s WHERE owner_id=%s AND id=%s AND result IS NULL",
                (Jsonb(output), job["owner_id"], job["id"]),
            )
        return await finish(
            self.db,
            task,
            output,
            error_code=None if output["state"] == "completed" else "celeb_source_" + output["state"],
        )
