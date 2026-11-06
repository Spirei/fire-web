"""Explicit installed SEC sources and durable administrator collection receipts."""

import hashlib
import ipaddress
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


class SecRequest:
    def __init__(self, target, url):
        self.target, self.url, self.user_agent = target, url, target["userAgent"]

    def request(self, cik=None):
        parsed = urlsplit(self.url)
        host = parsed.hostname
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.port not in (None, 443)
        ):
            raise ValueError("sec_url_invalid")
        cik = self.target["cik"]
        if host == "data.sec.gov":
            if parsed.path != f"/submissions/CIK{cik}.json":
                raise ValueError("sec_submission_scope")
        elif host == "www.sec.gov":
            if not re.fullmatch(
                r"/Archives/edgar/data/" + str(int(cik)) + r"/\d{18}/[A-Za-z0-9_.-]+", parsed.path
            ):
                raise ValueError("sec_archive_scope")
        else:
            raise ValueError("sec_host_scope")
        return self.url, {
            "target": ["https", host, 443, parsed.path],
            "addresses": self.target["addresses"][host],
            "allow_plaintext": False,
        }


class CelebSources:
    def __init__(self, db):
        self.db = db

    def target(self, owner, target_id):
        items = [r for r in self.db.settings.celeb_source_targets if r.get("id") == target_id]
        if len(items) != 1:
            raise HTTPException(503, "SEC来源尚未明确安装")
        row = items[0]
        try:
            if (
                row["ownerId"] != owner
                or row["instanceId"] != str(self.db.settings.instance_id)
                or row["approvedAccess"] is not True
                or row["purpose"] != "celebs.sec.collect"
                or row["provider"] != "sec-edgar"
                or not row["licenseRevision"]
                or datetime.fromisoformat(row["expiresAt"]) <= datetime.now(UTC)
                or not re.fullmatch(r"\d{10}", row["cik"])
                or row["sourceKind"] not in {"13f", "form4"}
                or not isinstance(row["userAgent"], str)
                or "@" not in row["userAgent"]
                or "\n" in row["userAgent"]
                or "\r" in row["userAgent"]
            ):
                raise ValueError()
            for host in ("data.sec.gov", "www.sec.gov"):
                pins = row["addresses"][host]
                if (
                    not isinstance(pins, list)
                    or not 1 <= len(pins) <= 32
                    or any(not ipaddress.ip_address(v).is_global for v in pins)
                ):
                    raise ValueError()
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(503, "SEC来源许可、身份或固定目标不可用") from exc
        return row

    async def lock(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=True)

    async def targets(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            rows = []
            for configured in self.db.settings.celeb_source_targets:
                try:
                    r = self.target(who.id, configured.get("id"))
                except HTTPException:
                    continue
                rows.append(
                    {
                        k: r[k]
                        for k in (
                            "id",
                            "celebId",
                            "cik",
                            "sourceKind",
                            "provider",
                            "licenseRevision",
                            "expiresAt",
                        )
                    }
                )
            return {
                "targets": rows,
                "state": "available" if rows else "unavailable",
                "collectionOnRead": False,
            }

    async def project(self, conn, row):
        task = await (
            await conn.execute(
                "SELECT status,error_code,lease_version,created_at,finished_at FROM tasks WHERE id=%s",
                (row["task_id"],),
            )
        ).fetchone()
        pages=await(await conn.execute('SELECT id,raw_sha256,http_status,complete FROM celeb_source_pages WHERE owner_id=%s AND job_id=%s ORDER BY received_at,id LIMIT 25',(row['owner_id'],row['id']))).fetchall()
        return {
            "requestId": str(row["request_id"]),
            "sourcePages":[{'id':str(page['id']),'sha256':page['raw_sha256'],'httpStatus':page['http_status'],'complete':page['complete'],'originalPath':'/api/celebs/sources/originals/'+str(page['id'])}for page in pages],
            "jobId": str(row["id"]),
            "taskId": str(row["task_id"]),
            "celebId": row["celeb_id"],
            "revision": row["revision"],
            "state": row["result"]["state"]
            if row["result"]
            else "unknown"
            if task["error_code"]
            else task["status"],
            "result": row["result"],
            "errorCode": task["error_code"],
            "createdAt": row["created_at"].isoformat(),
            "willRetryAutomatically": False,
            "scheduled": row["inputs"].get("scheduled", False),
            "refreshHours": row["inputs"].get("refreshHours"),
        }

    async def collect(self, who, raw):
        from .celeb_core import latest_on_connection

        if (
            not isinstance(raw, dict)
            or set(raw) - {"requestId", "celebId", "revision", "targetId", "scheduled"}
            or not {"requestId", "celebId", "revision", "targetId"} <= set(raw)
        ):
            raise HTTPException(400, "SEC采集字段无效")
        try:
            rid = str(UUID(raw["requestId"]))
        except (TypeError, ValueError, AttributeError) as exc:
            raise HTTPException(400, "请求UUID无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM celeb_source_jobs WHERE owner_id=%s AND request_id=%s", (who.id, rid)
                )
            ).fetchone()
            if prior:
                if prior["request_hash"] != fingerprint(raw):
                    raise HTTPException(409, "原UUID用于不同采集")
                return await self.project(conn, prior)
            target = self.target(who.id, raw["targetId"])
            head = await latest_on_connection(conn, raw["celebId"], public=False)
            if not head or head["revision"] != raw["revision"] or type(raw["revision"]) is not int:
                raise HTTPException(409, "名人来源修订已变化")
            payload = head["payload"]
            if "scheduled" in raw and type(raw["scheduled"]) is not bool:
                raise HTTPException(400, "定时采集确认无效")
            if raw.get("scheduled") is True and (
                payload.get("refreshHours", 0) <= 0 or payload.get("enabled") is not True
            ):
                raise HTTPException(409, "定时采集须启用人物且明确有效刷新间隔")
            inputs = {
                "scheduled": raw.get("scheduled") is True,
                "scheduleRoot": rid,
                "refreshHours": payload.get("refreshHours"),
            }

            if (
                target["celebId"] != raw["celebId"]
                or payload.get("cik") != target["cik"]
                or payload.get("sourceKind") != target["sourceKind"]
            ):
                raise HTTPException(409, "SEC目标与登记CIK或来源不一致")
            session = await (
                await conn.execute(
                    "SELECT s.token_hash,s.client_id,u.session_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=%s AND s.token_hash=%s AND s.client_id=ANY(%s) AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version",
                    (who.id, who.token_hash, ["new-web", "legacy-web"]),
                )
            ).fetchone()
            if not session:
                raise HTTPException(403, "SEC采集须管理员Web明确授权")
            count = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",
                    (who.id,),
                )
            ).fetchone()
            if count["n"] >= 100:
                raise HTTPException(429, "待处理任务过多")
            jid, tid = uuid4(), uuid4()
            subject = {
                "sessionHash": who.token_hash,
                "sessionClient": session["client_id"],
                "sessionVersion": session["session_version"],
                "instanceId": str(self.db.settings.instance_id),
            }
            await conn.execute(
                "INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'celeb.sec_collect','queued',%s)",
                (tid, who.id, rid, fingerprint(raw), Jsonb({"celebJobId": str(jid)})),
            )
            row = await (
                await conn.execute(
                    "INSERT INTO celeb_source_jobs(owner_id,id,request_id,task_id,celeb_id,revision,target_id,target_fingerprint,subject,request_hash,inputs) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                    (
                        who.id,
                        jid,
                        rid,
                        tid,
                        raw["celebId"],
                        raw["revision"],
                        raw["targetId"],
                        fingerprint(target),
                        Jsonb(subject),
                        fingerprint(raw),
                        Jsonb(inputs),
                    ),
                )
            ).fetchone()
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (tid,))
            return await self.project(conn, row)

    async def operation(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM celeb_source_jobs WHERE owner_id=%s AND request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "采集回执不存在")
            return await self.project(conn, row)

    async def original(self, who, page_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM celeb_source_pages WHERE owner_id=%s AND id=%s",
                    (who.id, UUID(str(page_id))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原件不存在")
            raw = bytes(row["raw"])
            if hashlib.sha256(raw).hexdigest() != row["raw_sha256"]:
                raise HTTPException(503, "原件校验失败")
            return row, raw
