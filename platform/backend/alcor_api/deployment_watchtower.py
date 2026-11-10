"""Private Watchtower notification and observed-runtime convergence; never a Docker executor."""

import asyncio
import socket
import urllib.error
import urllib.request
from datetime import UTC, datetime
from urllib.parse import urlsplit

HOSTS = {"fire-updater", "alcor-watchtower", "watchtower", "alcor-api-watchtower", "localhost", "127.0.0.1", "::1"}
LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))"


def endpoint(settings):
    raw = settings.deployment_updater_url
    if not raw:
        return None
    target = urlsplit(raw)
    if (any(ord(char) < 33 for char in raw) or target.scheme != "http" or target.hostname not in HOSTS or not target.netloc
            or target.username or target.password or target.query or target.fragment
            or target.path not in {"", "/", "/v1/update"} or target.port == 8081):
        raise ValueError("须配置独立 Watchtower 私网更新地址")
    return raw.rstrip("/") if target.path == "/v1/update" else raw.rstrip("/") + "/v1/update"


def configured(settings):
    try:
        token = settings.deployment_runner_token.get_secret_value() if settings.deployment_runner_token else ""
        return bool(endpoint(settings) and len(token) >= 32 and all(33 <= ord(char) <= 126 for char in token))
    except ValueError:
        return False


def probe(settings):
    result = {"configured": configured(settings), "online": False, "kind": "watchtower",
              "observed_at": None, "reason": "尚未配置独立 Watchtower"}
    if not result["configured"]:
        return result
    result["observed_at"] = datetime.now(UTC)
    target = urlsplit(endpoint(settings))
    try:
        # GET /v1/update is an action, never a health probe.
        with socket.create_connection((target.hostname, target.port or 80), timeout=1.5):
            result.update(online=True, reason="Watchtower 端口可达")
    except OSError:
        result["reason"] = "无法连接独立 Watchtower"
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def notify(settings):
    if not configured(settings):
        return {"status": "failed", "message": "尚未配置有效的独立 Watchtower 更新地址和 Token"}
    request = urllib.request.Request(endpoint(settings), method="GET", headers={
        "Authorization": "Bearer " + settings.deployment_runner_token.get_secret_value(),
        "Accept": "application/json",
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            if 200 <= response.status < 300:
                return {"status": "running", "message": "已通知 Watchtower，等待目标服务恢复并核对运行提交"}
            return {"status": "unknown", "message": "更新通知结果待核对，请查询原请求"}
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        if 300 <= status < 500 and status != 408:
            return {"status": "failed", "message": "Watchtower 未接受更新通知（HTTP " + str(status) + "）"}
    except (OSError, ValueError):
        pass
    return {"status": "unknown", "message": "更新通知结果待核对，请查询原请求；核对后可手动重试"}


def runtime_matches(settings, approved, *, version, schema):
    """A digest saved in an old environment cannot override baked runtime identity."""
    return bool(settings.source_revision and approved["revision"] == settings.source_revision
                and approved["version"] == version and approved["schema_hash"] == schema
                and approved["image"].split("@")[0] == settings.deployment_image)


async def runtime_ready(conn, *, version):
    """Call only on a connection that has verified the PG identity and migrations."""
    row = await (await conn.execute(
        "SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE version=%s "
        "AND observed_at>clock_timestamp()-interval '30 seconds') AS healthy", (version,),
    )).fetchone()
    return bool(row["healthy"])


async def dispatch(db, settings, record_id):
    """Commit uncertainty before the one network action, so replay can only observe."""
    async with db.connection() as conn, conn.transaction():
        await conn.execute(LOCK)
        row = await (await conn.execute("SELECT * FROM deployment_requests WHERE id=%s FOR UPDATE", (record_id,))).fetchone()
        if not row or row["status"] != "queued":
            return {"receipt": row, "message": "仅核对原更新请求"}
        owner = await (await conn.execute("SELECT active,role FROM users WHERE id=%s FOR SHARE", (row["owner_id"],))).fetchone()
        if not owner or not owner["active"] or owner["role"] != "admin":
            row = await (await conn.execute(
                "UPDATE deployment_requests SET status='cancelled',finished_at=clock_timestamp() WHERE id=%s RETURNING *", (record_id,),
            )).fetchone()
            return {"receipt": row, "message": "原管理员授权已变化，未通知 Watchtower"}
        row = await (await conn.execute(
            "UPDATE deployment_requests SET status='unknown',claimed_at=clock_timestamp() WHERE id=%s RETURNING *",
            (record_id,),
        )).fetchone()
    outcome = await asyncio.to_thread(notify, settings)
    async with db.connection() as conn, conn.transaction():
        await conn.execute(LOCK)
        updated = await (await conn.execute(
            "UPDATE deployment_requests SET status=%s,finished_at=CASE WHEN %s='failed' THEN clock_timestamp() ELSE NULL END "
            "WHERE id=%s AND status='unknown' RETURNING *",
            (outcome["status"], outcome["status"], record_id),
        )).fetchone()
        if updated:
            row = updated
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (row["owner_id"], "deployment.notification_" + outcome["status"], str(row["id"]), row["request_id"]),
            )
        else:
            row = await (await conn.execute("SELECT * FROM deployment_requests WHERE id=%s", (record_id,))).fetchone()
    message = "目标服务已就绪，运行提交核对通过" if row and row["status"] == "succeeded" else outcome["message"]
    return {"receipt": row, "message": message}


async def reconcile(db, settings, *, version, schema):
    """Only current API, verified PG and a fresh matching Worker can complete an approval."""
    if not settings.source_revision:
        return []
    async with db.connection() as conn, conn.transaction():
        await conn.execute(LOCK)
        if not await runtime_ready(conn, version=version):
            return []
        rows = await (await conn.execute(
            "SELECT * FROM deployment_requests WHERE status IN ('queued','running','unknown') "
            "AND revision=%s AND version=%s AND schema_hash=%s FOR UPDATE",
            (settings.source_revision, version, schema),
        )).fetchall()
        completed = []
        for row in rows:
            if not runtime_matches(settings, row, version=version, schema=schema):
                continue
            await conn.execute("UPDATE deployment_requests SET status='succeeded',finished_at=clock_timestamp() WHERE id=%s", (row["id"],))
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'deployment.succeeded',%s,%s)",
                (row["owner_id"], str(row["id"]), row["request_id"]),
            )
            completed.append(str(row["id"]))
        return completed
