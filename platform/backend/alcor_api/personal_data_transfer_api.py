"""Owned personal transfer adapters; whole database backup is a separate authority."""

import hashlib
import json
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .card_preferences_protocol import wire_response
from .fx_provider_parser import unique
from .personal_data_transfer import PersonalDataTransfer
from .profile_http import bounded_body
from .record_file_api import actor

HEADERS = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}
FILE_LIMIT = 10 * 1024 * 1024


async def parse(request, limit):
    raw = await bounded_body(request, limit)
    try:
        value = json.loads(raw, object_pairs_hook=unique, parse_float=Decimal,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "JSON原文无效") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "请求须为JSON对象")
    return raw, value


def mount_personal_data_transfer(app, db):
    service = PersonalDataTransfer(db)
    app.state.personal_data_transfer = service

    async def run(request, action, *, rid=None, legacy=False):
        headers = dict(HEADERS)
        try:
            if request.query_params and not (legacy and action == "import" and
                    set(request.query_params) == {"preview"} and request.query_params["preview"] == "1"
                    and len(request.query_params.getlist("preview")) == 1):
                raise HTTPException(400, "不接受这些查询参数")
            who = await actor(request, db, write=action in {"preview", "submit", "close", "import"})
            if action == "export":
                result = await service.export(who)
                headers["Content-Disposition"] = 'attachment; filename="personal-data.json"'
                headers["X-Alcor-Scope"] = "current-owner-personal-data"
                return wire_response(result, headers)
            if action in {"original", "before"}:
                UUID(rid)
                original = await (service.original(who, rid) if action == "original"
                                  else service.before_image(who, rid))
                content = original["raw"]
                if hashlib.sha256(content).hexdigest() != original["sha256"]:
                    raise HTTPException(409, "保留原件摘要不一致")
                headers.update({"Content-Disposition": 'attachment; filename="personal-data.json"',
                                "X-Content-Type-Options": "nosniff",
                                "X-Alcor-SHA256": original["sha256"]})
                return Response(content, media_type=original["mediaType"], headers=headers)
            if action == "receipt":
                return wire_response(await service.receipt(who, str(UUID(rid))), headers)
            if action == "close":
                body = await bounded_body(request, 4096)
                if body not in (b"", b"{}"):
                    raise HTTPException(400, "关闭操作只接受原UUID")
                return wire_response(await service.close(who, str(UUID(rid))), headers)
            limit = 6 * FILE_LIMIT + 65536 if action in {"preview", "import"} else 16384
            original, raw = await parse(request, limit)
            if action == "import":
                # Legacy files remain exact UTF-8 originals. Preview and explicit
                # confirmation use the same UUID; receipt replay never reimports.
                if "previewId" in raw:
                    if request.query_params:
                        raise HTTPException(400, "预览请求不能执行确认，请移除preview参数后显式提交")
                    result = await service.submit(who, raw)
                else:
                    if raw.get("format") == "fire-site-backup":
                        if len(original) > FILE_LIMIT:
                            raise HTTPException(413, "个人备份超过10MiB")
                        raw = {"payloadText": original.decode("utf-8"),
                               "requestId": request.headers.get("x-alcor-request-id") or str(uuid4()),
                               "mappings": {}}
                    elif "requestId" not in raw:
                        raw["requestId"] = request.headers.get("x-alcor-request-id") or str(uuid4())
                    result = await service.preview(who, raw)
                    if result.get("state") == "previewed":
                        result = {**result, "preview": True, "executed": False,
                                  "confirmationPath": "/api/personal-data-transfer/submit"}
            else:
                result = await (service.preview(who, raw) if action == "preview" else service.submit(who, raw))
            if result.get("requestId"):
                headers["X-Alcor-Request-Id"] = str(result["requestId"])
            return wire_response(result, headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return wire_response({"error": exc.detail}, headers, exc.status_code)
        except (ValueError, TypeError, UnicodeError):
            return wire_response({"error": "请求编号或JSON内容无效"}, headers, 400)

    def endpoint(action, legacy=False):
        async def handler(request: Request):
            return await run(request, action, legacy=legacy)
        return handler

    for method, suffix, action in (("GET", "export", "export"), ("POST", "preview", "preview"),
                                   ("POST", "submit", "submit")):
        app.add_api_route("/api/personal-data-transfer/" + suffix, endpoint(action), methods=[method],
                          operation_id="personal_data_transfer_" + action)
    for path, method, action in (("operations/{rid}", "GET", "receipt"),
                                  ("operations/{rid}/close", "POST", "close"),
                                  ("originals/{rid}", "GET", "original"),
                                  ("before-images/{rid}", "GET", "before")):
        def bound(selected):
            async def handler(request: Request, rid: str):
                return await run(request, selected, rid=rid)
            return handler
        app.add_api_route("/api/personal-data-transfer/" + path, bound(action), methods=[method],
                          operation_id="personal_data_transfer_" + action)
    app.add_api_route("/api/v1/data/export", endpoint("export", True), methods=["GET"],
                      operation_id="legacy_personal_data_export")
    app.add_api_route("/api/v1/data/import", endpoint("import", True), methods=["POST"],
                      operation_id="legacy_personal_data_import")
    return service
