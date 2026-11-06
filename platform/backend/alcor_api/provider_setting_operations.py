"""Explicit provider probes and secret reveals over the encrypted settings authority."""

import hashlib
import json
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .notification_provider_protocols import ProviderRejected
from .notification_security import NotificationSecurity
from .notification_smtp import Smtp
from .provider_setting_transport import approved_model_target, interpreted
from .provider_setting_transport import read as model_read
from .security import lock_mutation_identity


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


class ProviderSettingOperations:
    def __init__(self, db):
        self.db = db

    def registry(self):
        from .private_runtime_settings import PrivateRuntimeSettings

        return PrivateRuntimeSettings(self.db)

    async def lock(self, conn, who, raw=None, *, proof=False):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=True)
        if proof or raw and raw.get("password"):
            password = (raw or {}).get("password") or (raw or {}).get("currentPassword")
            if not isinstance(password, str) or not password:
                raise HTTPException(428, "请核对当前管理员密码及安全因子")
            try:
                await NotificationSecurity(self.db).passkeys.step_up(
                    conn, who, password, (raw or {}).get("code") or ""
                )
            except HTTPException as exc:
                if exc.status_code == 403 and exc.detail in {"当前密码不正确", "二次验证码或备用码不正确"}:
                    raise HTTPException(
                        403,
                        exc.detail,
                        headers={"X-Alcor-Operation-Admitted": "false", "X-Alcor-Proof-Rejected": "true"},
                    ) from exc
                raise

    async def private(self, conn, expected=None):
        revision, raw = await self.registry().private_on_connection(conn)
        if expected is not None and revision != expected:
            raise HTTPException(409, "提供商配置已变化，请重新读取")
        return revision, raw

    def approval(self, who, value, purpose, url=None):
        try:
            if (
                not isinstance(value, dict)
                or value["approvedAccess"] is not True
                or value["ownerId"] != who.id
                or str(value["instanceId"]) != str(self.db.settings.instance_id)
                or value["purpose"] != purpose
                or not value["licenseRevision"]
                or datetime.fromisoformat(value["expiresAt"]) <= datetime.now(UTC)
            ):
                raise ValueError()
            if url is not None:
                parsed = urlsplit(url)
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
                if (
                    parsed.username
                    or parsed.password
                    or parsed.query
                    or parsed.fragment
                    or (parsed.hostname, port, parsed.path) != (value["host"], value["port"], value["path"])
                ):
                    raise ValueError()
                approved_model_target(url, value, value["addresses"])
            return value
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(409, "提供商固定目标、用途或许可尚未核对") from exc

    def model(self, who, document, raw):
        if "models" in document.get("_unavailableGroups", []):
            raise HTTPException(503, "模型配置密文不可用")
        services = document.get("modelServices") or []
        candidates = [s for s in services if s.get("id") == raw.get("serviceId")]
        if len(candidates) != 1:
            raise HTTPException(404, "已保存模型服务不存在")
        service = candidates[0]
        provider = raw.get("provider") or service.get("provider")
        config = (
            service
            if provider == service.get("provider")
            else service.get("providerConfigs", {}).get(provider)
        )
        if not isinstance(config, dict) or provider not in {"deepseek", "openai", "jev", "custom"}:
            raise HTTPException(409, "此提供商协议尚未配置")
        url = raw.get("apiUrl", config.get("apiUrl"))
        key = raw.get("apiKey")
        if key in (None,"","********"):key=config.get("apiKey")
        model = raw.get("model") or config.get("selectedModel")
        if not isinstance(model, str) or model not in config.get("models", []):
            raise HTTPException(409, "请明确选择已保存模型")
        if not isinstance(key, str) or not key or any(c in key for c in "\r\n\0"):
            raise HTTPException(409, "模型凭据尚未配置")
        declared = config.get("approval") or service.get("approval")
        parsed_url = urlsplit(url)
        if (
            isinstance(declared, dict)
            and declared.get("path") == parsed_url.path.rstrip("/") + "/chat/completions"
        ):
            url = urlunsplit(
                (
                    parsed_url.scheme,
                    parsed_url.netloc,
                    declared["path"],
                    parsed_url.query,
                    parsed_url.fragment,
                )
            )
        policy = self.approval(who, declared, "provider.model.test", url)
        parsed = urlsplit(url)
        return {
            "id": service["id"],
            "provider": provider,
            "url": url,
            "apiKey": key,
            "model": model,
            "addresses": policy["addresses"],
            "allowPlaintext": policy.get("allowPlaintext") is True,
            "approval": policy,
        }

    def smtp(self, who, document, raw):
        if "smtp" in document.get("_unavailableGroups", []):
            raise HTTPException(503, "邮件配置密文不可用")
        values = {**document, **{k: v for k, v in raw.items() if k.startswith("smtp")}}
        policy = self.approval(who, document.get("smtpApproval"), "smtp.send")
        host = values.get("smtpHost")
        port = int(values.get("smtpPort") or 587)
        mode = "tls" if values.get("smtpSecure") is True else "starttls"
        if (host, port) != (policy.get("host"), policy.get("port")) or policy.get("mode", mode) != mode:
            raise HTTPException(409, "邮件目标尚未批准")
        # SMTP is always TLS/STARTTLS; private pins still require explicit approval.
        approved_model_target(
            "https://" + host + ":" + str(port) + "/", {**policy, "path": "/"}, policy["addresses"]
        )
        if raw.get('smtpPassword')in (None,'','********')and document.get('smtpPassword'):
            endpoint=lambda v:(str(v.get('smtpHost')or'').strip().lower().rstrip('.'),int(v.get('smtpPort')or 587),v.get('smtpSecure')is True,str(v.get('smtpUser')or'').strip())
            if endpoint(values)!=endpoint(document):raise HTTPException(409,'SMTP地址或账号已更改，请输入新密码')
            values['smtpPassword']=document['smtpPassword']
        config = {
            "username": values.get("smtpUser") or "",
            "password": values.get("smtpPassword") or "",
            "fromEmail": values.get("smtpFromEmail") or "",
            "fromName": values.get("smtpFromName") or "",
        }
        if any(not isinstance(v, str) or "\r" in v or "\n" in v for v in config.values()):
            raise HTTPException(400, "邮件配置字段无效")
        return {
            "provider": "smtp",
            "policy": {"host": host, "port": port, "mode": mode, "addresses": policy["addresses"]},
            "config": config,
            "approval": policy,
        }

    def fp(self, value):
        return NotificationSecurity(self.db).mac(value)

    async def admit(self, conn, who, kind, raw, config, revision):
        rid = UUID(str(raw["requestId"]))
        safe = {k: v for k, v in raw.items() if k not in {"password", "currentPassword", "code"}}
        hashed = self.fp({"kind": kind, "raw": safe})
        fp = self.fp(config)
        prior = await (
            await conn.execute(
                "SELECT * FROM provider_setting_operations WHERE owner_id=%s AND request_id=%s", (who.id, rid)
            )
        ).fetchone()
        if prior:
            if prior["request_hash"] != hashed or prior["kind"] != kind:
                raise HTTPException(409, "原UUID用于不同提供商操作")
            return prior
        await conn.execute(
            "INSERT INTO provider_setting_operations(owner_id,request_id,kind,request_hash,config_revision,config_fingerprint,service_id,model,origin_instance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (who.id, rid, kind, hashed, revision, fp, config.get("id"), config.get("model"),self.db.settings.instance_id),
        )
        return None

    def projected(self, row):
        return row["result"] or {
            "requestId": str(row["request_id"]),
            "state": "unknown",
            "kind": row["kind"],
            "willRetryAutomatically": False,
        }

    async def test(self, who, kind, raw):
        if kind not in {"model-test", "mail-test"}:
            raise HTTPException(404, "测试类型不存在")
        rid = UUID(str(raw["requestId"]))
        destination = None
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who, raw)
            revision, document = await self.private(conn, raw.get("expectedRevision"))
            target = self.model(who, document, raw) if kind == "model-test" else self.smtp(who, document, raw)
            if prior := await self.admit(conn, who, kind, raw, target, revision):
                return self.projected(prior)
            from .fx_reference import external_delivery_blocked

            if await external_delivery_blocked(conn):
                raise HTTPException(409, "恢复实例尚未重新授权外部操作")
            if kind == "mail-test":
                user = await (
                    await conn.execute("SELECT u.email,COALESCE(s.email_verified,false) AS email_verified FROM users u LEFT JOIN identity_security s ON s.user_id=u.id WHERE u.id=%s", (who.id,))
                ).fetchone()
                if not user or not user["email"] or not user["email_verified"]:
                    raise HTTPException(400, "请先在个人信息中验证邮箱")
                destination = user["email"]
        result = {"requestId": str(rid), "kind": kind, "state": "unknown", "willRetryAutomatically": False}
        started = time.monotonic()

        async def authorized():
            try:
                async with self.db.connection() as conn, conn.transaction():
                    await self.lock(conn, who)
                    current_revision, current = await self.private(conn, revision)
                    fresh = (
                        self.model(who, current, raw)
                        if kind == "model-test"
                        else self.smtp(who, current, raw)
                    )
                    return current_revision == revision and self.fp(fresh) == self.fp(target)
            except HTTPException:
                return False

        try:
            if kind == "model-test":
                if not await authorized():
                    raise ProviderRejected("authorization_changed_before_call")
                response = await model_read(target)
                # Original bytes commit before any subsequent actor/config check.
                async with self.db.connection() as conn, conn.transaction():
                    binding=await(await conn.execute('SELECT 1 FROM provider_setting_operations o JOIN alcor_instance i ON i.singleton AND o.origin_instance=i.instance_id WHERE o.owner_id=%s AND o.request_id=%s AND o.kind=%s AND o.origin_instance=%s AND o.config_fingerprint=%s',(who.id,rid,kind,self.db.settings.instance_id,self.fp(target)))).fetchone()
                    if not binding:return {**result,'reason':'admitted_original_instance_unavailable'}
                    page = await (
                        await conn.execute(
                            "INSERT INTO provider_setting_pages(owner_id,id,request_id,raw,raw_sha256,http_status,complete) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                            (
                                who.id,
                                uuid4(),
                                rid,
                                response["raw"],
                                hashlib.sha256(response["raw"]).hexdigest(),
                                response["status"],
                                response["complete"],
                            ),
                        )
                    ).fetchone()
                result.update(
                    sourcePageId=str(page["id"]),
                    latencyMs=response["latencyMs"],
                    httpStatus=response["status"],
                )
                if response["complete"] and response["status"] == 200:
                    try:
                        ok = interpreted(response["raw"], target["provider"])
                    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
                        ok = False
                    result.update(
                        state="completed" if ok else "rejected",
                        ok=ok,
                        error=None if ok else "incompatible_or_incomplete_response",
                    )
                elif response["complete"] and 400 <= response["status"] < 500:
                    result.update(state="rejected", ok=False, error="provider_rejected")
            else:
                await Smtp(target["policy"]).perform(
                    target["config"],
                    destination=destination,
                    content="Alcor 邮件配置测试",
                    authorize=authorized,
                    request_id=rid,
                )
                result.update(
                    state="completed",
                    ok=True,
                    email=destination,
                    latencyMs=round((time.monotonic() - started) * 1000),
                    deliveryAuthority="smtp_accepted_not_inbox_delivery_confirmed",
                )
        except ProviderRejected:
            result.update(state="rejected", ok=False, error="authorization_or_provider_rejected")
        except Exception:  # noqa: BLE001
            result["reason"] = "admitted_provider_outcome_unconfirmed"
        async with self.db.connection() as conn, conn.transaction():
            # Never drop an admitted IO result just because the current actor changed.
            observed = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            result["checkedAt"] = observed.isoformat()
            await conn.execute(
                "UPDATE provider_setting_operations SET result=%s WHERE owner_id=%s AND request_id=%s AND result IS NULL AND origin_instance=%s AND EXISTS(SELECT 1 FROM alcor_instance WHERE singleton AND instance_id=%s)",
                (Jsonb(result), who.id, rid,self.db.settings.instance_id,self.db.settings.instance_id),
            )
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
        return result

    async def tests(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            revision, document = await self.private(conn)
            tests = {}
            for service in document.get("modelServices") or []:
                for model in service.get("models") or []:
                    try:
                        target = self.model(who, document, {"serviceId": service["id"], "model": model})
                    except HTTPException:
                        continue
                    row = await (
                        await conn.execute(
                            "SELECT result,request_id,created_at FROM provider_setting_operations WHERE owner_id=%s AND kind='model-test' AND service_id=%s AND model=%s AND config_fingerprint=%s AND result->>'state' IN ('completed','rejected') ORDER BY created_at DESC LIMIT 1",
                            (who.id, service["id"], model, self.fp(target)),
                        )
                    ).fetchone()
                    if row:
                        tests[service["id"] + ":" + model] = {
                            **row["result"],
                            "requestId": str(row["request_id"]),
                            "checkedAt": row["result"].get("checkedAt", row["created_at"].isoformat()),
                        }
            return {"revision": revision, "tests": tests}

    async def reveal(self, who, raw):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who, raw, proof=True)
            revision, document = await self.private(conn, raw.get("expectedRevision"))
            cookie = document.get("xueqiuCookie")
            target_id = document.get("xueqiuCookieTargetId")
            if not isinstance(cookie, str) or not cookie:
                raise HTTPException(404, "尚未配置Cookie")
            from .feed_sources import FeedSources

            target = FeedSources(self.db).target(who.id, target_id)
            if (
                target.get("provider") != "xueqiu-status-json"
                or urlsplit(target["url"]).hostname != "api.xueqiu.com"
            ):
                raise HTTPException(409, "Cookie固定来源绑定不一致")
            config = {"id": target_id, "cookie": cookie, "fingerprint": fingerprint_target(target)}
            prior = await self.admit(conn, who, "xueqiu-cookie", raw, config, revision)
            if prior and prior["config_fingerprint"] != self.fp(config):
                raise HTTPException(409, "原Cookie配置已变化")
            result = {
                "requestId": str(raw["requestId"]),
                "state": "completed",
                "kind": "xueqiu-cookie",
                "secretRead": True,
                "willRetryAutomatically": False,
            }
            if not prior:
                await conn.execute(
                    "UPDATE provider_setting_operations SET result=%s WHERE owner_id=%s AND request_id=%s",
                    (Jsonb(result), who.id, UUID(str(raw["requestId"]))),
                )
            return {**result, "cookie": cookie}

    async def icon(self, who, raw, image, filename):
        from .market_worker import Bound
        from .system_assets import SystemAssets

        rid = UUID(str(raw["requestId"]))
        image_sha = hashlib.sha256(image).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who, raw, proof=True)
            # The original immutable result wins over a revision advanced by this
            # upload itself; compare the complete same image/body before replay.
            command = {k: v for k, v in raw.items() if k not in {"password", "currentPassword", "code"}} | {"imageSha256": image_sha}
            prior = await (await conn.execute("SELECT * FROM provider_setting_operations WHERE owner_id=%s AND request_id=%s", (who.id, rid))).fetchone()
            if prior:
                if prior["kind"] != "model-icon" or prior["request_hash"] != self.fp({"kind":"model-icon", "raw":command}):
                    raise HTTPException(409, "原UUID用于不同提供商操作")
                return self.projected(prior)
            revision, document = await self.private(conn, raw.get("expectedRevision"))
            services = document.get("modelServices") or []
            proposed = raw.get("modelServices")
            if proposed is not None:

                def same(proposal, current):
                    if isinstance(proposal, dict) and isinstance(current, dict):
                        for key, value in proposal.items():
                            if key.endswith("Configured") or key in {"apiKeyConfigured", "secretConfigured"}:
                                continue
                            if key == "apiKey" and value in (None, ""):
                                continue
                            if key not in current or not same(value, current[key]):
                                return False
                        return True
                    return proposal == current

                if (
                    not isinstance(proposed, list)
                    or len(proposed) != len(services)
                    or any(not isinstance(v, dict) for v in proposed)
                ):
                    raise HTTPException(409, "请先保存模型服务配置，再上传图标")
                current_by_id = {v["id"]: v for v in services}
                if len({v.get("id") for v in proposed}) != len(proposed) or any(
                    v.get("id") not in current_by_id or not same(v, current_by_id[v["id"]]) for v in proposed
                ):
                    raise HTTPException(409, "请先保存模型服务配置，再上传图标")
            selected = [v for v in services if v.get("id") == raw.get("serviceId")]
            if len(selected) != 1:
                raise HTTPException(404, "模型服务不存在")
            command = {k: v for k, v in raw.items() if k not in {"password", "currentPassword", "code"}} | {
                "imageSha256": image_sha
            }
            prior = await self.admit(
                conn,
                who,
                "model-icon",
                command,
                {"id": selected[0]["id"], "revision": revision, "imageSha256": image_sha},
                revision,
            )
            if prior:
                return self.projected(prior)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('system-public-assets',0))")
            asset = await SystemAssets(Bound(conn, self.db.settings)).apply(
                conn,
                who.id,
                {
                    "kind": "asset",
                    "folder": "icon",
                    "name": selected[0].get("name") or selected[0]["id"],
                    "code": selected[0]["id"],
                    "market": "",
                },
                filename,
                image,
            )
            await conn.execute(
                "UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'"
            )
            url = asset["url"]
            provider = selected[0]["provider"]
            updated = []
            actions = {}
            for original in services:
                service = dict(original)
                service.pop("apiKey", None)
                actions["modelServices." + service["id"] + ".apiKey"] = {"action": "keep"}
                if isinstance(service.get("providerConfigs"), dict):
                    configs = {}
                    for key, values in service["providerConfigs"].items():
                        value = dict(values)
                        value.pop("apiKey", None)
                        configs[key] = value
                        actions["modelServices." + service["id"] + ".providerConfigs." + key + ".apiKey"] = {
                            "action": "keep"
                        }
                    service["providerConfigs"] = configs
                if service["id"] == selected[0]["id"]:
                    service.update(icon=url, icons={**service.get("icons", {}), provider: url})
                updated.append(service)
            child = str(uuid5(rid, "model-icon-registry:" + image_sha))
            saved = await self.registry().save(
                who,
                {
                    "requestId": child,
                    "expectedRevision": revision,
                    "group": "models",
                    "patch": {"modelServices": updated},
                    "secretActions": actions,
                },
                connection=conn,
            )
            result = {
                "requestId": str(rid),
                "state": "completed",
                "kind": "model-icon",
                "url": url,
                "imageVersion": asset["version"],
                "result": saved,
                "childRequestId": child,
                "willRetryAutomatically": False,
            }
            await conn.execute(
                "UPDATE provider_setting_operations SET result=%s WHERE owner_id=%s AND request_id=%s",
                (Jsonb(result), who.id, rid),
            )
            return result

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM provider_setting_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "提供商操作回执不存在")
            return self.projected(row)

    async def original(self, who, page_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            page = await (
                await conn.execute(
                    "SELECT * FROM provider_setting_pages WHERE owner_id=%s AND id=%s",
                    (who.id, UUID(str(page_id))),
                )
            ).fetchone()
            if not page:
                raise HTTPException(404, "提供商原始响应不存在")
            raw = bytes(page["raw"])
            if hashlib.sha256(raw).hexdigest() != page["raw_sha256"]:
                raise HTTPException(503, "提供商原件校验失败")
            return raw


def fingerprint_target(target):
    return hashlib.sha256(canonical(target).encode()).hexdigest()
