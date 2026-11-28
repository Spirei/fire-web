"""The private updater keeps a release request alive across a Fire restart."""

import argparse
import fcntl
import hmac
import json
import logging
import os
import re
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

from .backups import private_dir
from .db import TargetMismatch
from .deployment_runtime import Runtime, save_json
from .fire_config import load_fire_settings
from .migrate import pending_migrations


log = logging.getLogger(__name__)
ACTIVE = {"queued", "running", "maintenance_required"}
FIELDS = {"id", "request_id", "owner_id", "image", "version", "revision", "schema_hash", "instance_id", "environment", "database"}


def identifier(value):
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError("Invalid identifier")
    return value


def validate(raw, repository):
    if not isinstance(raw, dict) or raw.keys() != FIELDS or not all(isinstance(v, str) for v in raw.values()):
        raise ValueError("Invalid approval")
    for key in ("id", "request_id", "instance_id"):
        identifier(raw[key])
    for key, pattern in {
        "image": re.escape(repository) + r"@sha256:[a-f0-9]{64}",
        "revision": r"[a-f0-9]{40}", "schema_hash": r"[a-f0-9]{64}", "version": r"\d+\.\d+\.\d+",
    }.items():
        if not re.fullmatch(pattern, raw[key]):
            raise ValueError("Invalid release")
    if not all(0 < len(raw[key]) <= 128 and raw[key].isprintable() for key in ("owner_id", "environment", "database")):
        raise ValueError("Invalid database or owner")
    return raw


def public(state):
    return {key: state[key] for key in ("status", "stage", "message")} | {"request_id": state["approval"]["request_id"]}


class Runner:
    def __init__(self, root, runtime):
        self.root = private_dir(root)
        self.runtime = runtime
        self.lock = threading.Lock()
        self.wake = threading.Event()

    def path(self, request_id):
        return self.root / (identifier(request_id) + ".json")

    def read(self, request_id):
        path = self.path(request_id)
        return json.loads(path.read_text()) if path.exists() else None

    def accept(self, approval):
        self.runtime.authorize(approval)
        with self.lock:
            state = self.read(approval["request_id"])
            if state:
                if state["approval"] != approval:
                    raise ValueError("Original request has a different approval")
                if state["status"] in {"failed", "maintenance_required"}:
                    if not any(self.read(path.stem)["status"] in ACTIVE for path in self.root.glob("*.json")
                               if path != self.path(approval["request_id"])):
                        self.update(state, "queued", state["stage"], "正在续接原发布请求")
            else:
                if any(self.read(path.stem)["status"] in ACTIVE for path in self.root.glob("*.json")):
                    raise ValueError("There is an unfinished release")
                state = {"approval": approval}
                self.update(state, "queued", "preflight", "已记录目标镜像及数据库，等待预检")
        self.wake.set()
        return public(state)

    def update(self, state, status, stage, message):
        state.update(status=status, stage=stage, message=message)
        save_json(self.path(state["approval"]["request_id"]), state)

    def execute(self, state):
        job = state["approval"]
        runtime = self.runtime
        try:
            runtime.authorize(job)
            self.update(state, "running", state["stage"], "正在核对目标镜像及数据库")
            target = runtime.target(job)
            current = runtime.applied(job)
            if "source" not in state:
                pending_migrations(current, target["migrations"])
                old = runtime.running(job)
                state.update(source=current, old=old, target=target)
                self.update(state, "running", "validated", "目标镜像及当前数据库已核对")
            if target != state["target"] or current not in (state["source"], target["migrations"]):
                raise TargetMismatch("Target or database changed since preflight")

            if state["source"] != target["migrations"]:
                if "backup" in state and current == state["source"] and runtime.writers_running(state["old"]):
                    if runtime.migration_active(job):
                        raise TargetMismatch("A source service restarted during migration")
                    state.pop("backup")
                if "backup" not in state:
                    if current != state["source"]:
                        raise TargetMismatch("Database changed before a backup was verified")
                    self.update(state, "running", "stopping", "暂停 Fire 写入，准备保留最后提交")
                    runtime.stop(state["old"])
                    state["backup"] = runtime.backup(job, state["source"])
                    self.update(state, "running", "backup_verified", "最后一份数据库备份已按原实例恢复验证")
                else:
                    runtime.verify_backup(job, state["backup"])

            if current != target["migrations"]:
                self.update(state, "running", "migrating", "正在执行目标镜像缺少的迁移")
                runtime.migrate(job, state["old"])
            if runtime.applied(job) != target["migrations"]:
                raise TargetMismatch("Target migration receipts do not match after migration")
            self.update(state, "running", "switching", "数据库已核对，正在切换到固定镜像")
            started = runtime.clock(job)
            runtime.switch(state["old"], job["image"])
            runtime.ready(state["old"], target, job, started)
            runtime.finish(job, target["migrations"])
            self.update(state, "succeeded", "ready", "目标镜像、数据库及服务就绪检查均已通过")
        except Exception as exc:
            log.warning("deployment stage failed request=%s stage=%s type=%s",
                        job["request_id"], state["stage"], type(exc).__name__)
            if state["stage"] in {"preflight", "validated"}:
                self.update(state, "failed", state["stage"], "预检失败，原服务保留")
                return
            try:
                old = state["old"]
                if not runtime.migration_active(job) and runtime.applied(job) == old["migrations"]:
                    started = runtime.clock(job)
                    # Invalidate the backup before the old service can accept
                    # new writes, even if the updater stops during recovery.
                    state.pop("backup", None)
                    self.update(state, "running", "recovering_old", "旧数据库仍兼容，正在恢复旧服务")
                    runtime.switch(old, old["id"])
                    runtime.ready(old, old, job, started)
                    self.update(state, "failed", state["stage"], "发布失败，已核对旧镜像与数据库并恢复服务")
                    return
                runtime.stop(old)
            except Exception as recovery:
                log.warning("rollback check failed request=%s type=%s", job["request_id"], type(recovery).__name__)
            self.update(state, "maintenance_required", state["stage"],
                        "发布已停在维护状态。保留当前数据库及备份，请使用原请求继续恢复")

    def work(self):
        while True:
            with self.lock:
                states = [self.read(path.stem) for path in sorted(self.root.glob("*.json"))]
                state = next((entry for entry in states if entry["status"] in {"queued", "running"}), None)
            if state:
                self.execute(state)
            else:
                self.wake.wait(2)
                self.wake.clear()


def handler(runner, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, code, payload):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            if hmac.compare_digest(self.headers.get("Authorization", "").encode(), b"Bearer " + token):
                return True
            self.reply(401, {"message": "更新器凭据无效"})
            return False

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/v1/health":
                self.reply(200, {"kind": "fire-release-updater"})
                return
            try:
                state = runner.read(self.path.removeprefix("/v1/update/")) if self.path.startswith("/v1/update/") else None
            except ValueError:
                state = None
            self.reply(200 if state else 404, public(state) if state else {"message": "未找到原发布请求"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/v1/update":
                self.reply(404, {"message": "未找到更新路径"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192:
                    raise ValueError("Request size")
                approval = validate(json.loads(self.rfile.read(length)), runner.runtime.repository)
                result = runner.accept(approval)
            except (ValueError, TargetMismatch):
                self.reply(409, {"message": "发布预检或原请求核对失败"})
            except Exception:
                self.reply(503, {"message": "暂无法记录发布请求，请查询原编号"})
            else:
                self.reply(202, result)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    operations = parser.add_mutually_exclusive_group()
    operations.add_argument("--status", metavar="REQUEST_ID")
    operations.add_argument("--resume", metavar="REQUEST_ID")
    args = parser.parse_args()
    settings = load_fire_settings()
    runtime = Runtime(settings)
    runner = Runner(Path(os.environ["FIRE_DEPLOYMENT_STATE_DIR"]), runtime)
    token = settings.deployment_runner_token.get_secret_value().encode()
    if len(token) < 32:
        raise ValueError("Updater token is required")
    if args.status or args.resume:
        state = runner.read(args.status or args.resume)
        if not state:
            raise SystemExit("未找到原发布请求")
        if args.resume:
            request = urllib.request.Request(
                "http://127.0.0.1:8080/v1/update", data=json.dumps(state["approval"]).encode(),
                headers={"Authorization": "Bearer " + token.decode(), "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                print(response.read(8192).decode())
        else:
            print(json.dumps(public(state), ensure_ascii=False))
        return
    with (runner.root / "updater.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        threading.Thread(target=runner.work, daemon=True).start()
        ThreadingHTTPServer(("0.0.0.0", 8080), handler(runner, token)).serve_forever()


if __name__ == "__main__":
    main()
