"""Old administrator settings adapters over the single PG template authority.

Legacy requests have no client revision or retry UUID. Their generated receipt
and server-read CAS cannot prove that the editor saw the latest revision.
"""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .legacy_identity import legacy_me_mutation_trusted, web_identity
from .mail_template_model import validate
from .profile_http import bounded_body


def mount_legacy_mail_template_settings(app, db):
    service = app.state.mail_templates
    headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}

    def response(value, status=200, extra=None):
        return JSONResponse(value, status_code=status, headers={**headers, **(extra or {})})

    async def admin(request):
        try:
            authorization = request.headers.get("authorization", "")
            checked = request
            if authorization.startswith("Bearer "):
                # getSessionToken in the old source trims the explicit token.
                # Keep an empty trimmed bearer so the existing cookie can win.
                trimmed = "Bearer " + authorization[7:].strip()
                checked = Request(
                    {
                        **request.scope,
                        "headers": [
                            (name, trimmed.encode("latin-1"))
                            if name.lower() == b"authorization"
                            else (name, value)
                            for name, value in request.scope["headers"]
                        ],
                    }
                )
            who = (await web_identity(checked, db, allow_legacy_bearer=True))[0]
            if who.role != "admin":
                return None
            return who
        except HTTPException:
            return None

    @app.get("/api/settings/mail-templates", tags=["legacy-web-admin"])
    async def read(request: Request):
        who = await admin(request)
        if who is None:
            return response({"error": "需要管理员权限"}, 403)
        try:
            current = await service.read(who)
        except HTTPException:
            return response({"error": "需要管理员权限"}, 403)
        return response(
            {"templates": current["templates"]},
            extra={"X-Alcor-Templates-Revision": str(current["revision"])},
        )

    @app.get("/api/settings/mail-templates/operations/{request_id}", tags=["legacy-web-admin"])
    async def operation(request_id: UUID, request: Request):
        who = await admin(request)
        if who is None:
            return response({"error": "需要管理员权限"}, 403)
        try:
            return response(await service.receipt(who, request_id))
        except HTTPException as exc:
            return response(
                {"error": "需要管理员权限" if exc.status_code in (401, 403) else str(exc.detail)},
                403 if exc.status_code in (401, 403) else exc.status_code,
            )

    @app.put("/api/settings/mail-templates", tags=["legacy-web-admin"])
    async def save(request: Request):
        if not legacy_me_mutation_trusted(request):
            return response({"error": "需要管理员权限"}, 403)
        who = await admin(request)
        if who is None:
            return response({"error": "需要管理员权限"}, 403)
        try:
            declared = request.headers.get("content-length", "")
            try:
                if float(declared) > 16384:
                    return response({"error": "request body too large"}, 400)
            except ValueError:
                pass
            try:
                raw = await bounded_body(request, 16384)
            except HTTPException as exc:
                if exc.status_code == 413:
                    return response({"error": "request body too large"}, 400)
                raise

            def invalid_constant(_):
                raise ValueError()

            try:
                template = json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
            except (ValueError, UnicodeError):
                template = None
            # Match the original post-body authorization check, then revalidate
            # again while the shared service holds the transaction identity lock.
            if await admin(request) is None:
                return response({"error": "登录已失效"}, 403)
            if not isinstance(template, dict):
                return response({"error": "模板格式无效"}, 400)
            normalized = validate(template)
            current = await service.read(who)
            expected = request.headers.get("x-alcor-templates-revision")
            if expected is None:
                revision = current["revision"]
            elif (
                not expected.isascii()
                or not expected.isdecimal()
                or len(expected) > 16
                or int(expected) >= 9007199254740991
            ):
                return response({"error": "集合版本无效"}, 400)
            else:
                revision = int(expected)
            supplied = request.headers.get("x-alcor-request-id")
            try:
                rid = UUID(supplied) if supplied is not None else uuid4()
            except ValueError:
                return response({"error": "原操作编号无效"}, 400)
            # A retry requires its original revision; deriving a new revision
            # from current state would change the shared service fingerprint.
            if supplied is not None and expected is None:
                return response({"error": "请同时提供原操作编号和集合版本"}, 400)
            receipt = await service.save(
                who, {"requestId": str(rid), "expectedRevision": revision, "template": normalized}
            )
            extra = {
                "X-Alcor-Request-Id": str(rid),
                "X-Alcor-Templates-Revision": str(receipt["revision"]),
                "X-Alcor-Request-Id-Mode": "provided" if supplied else "generated_legacy",
            }
            if receipt["state"] != "completed":
                return response({"error": receipt["message"]}, receipt["status"], extra)
            # The response is a current verified list; the durable original
            # operation result remains queryable through the existing receipt API.
            result = await service.read(who)
            extra["X-Alcor-Templates-Revision"] = str(result["revision"])
            return response({"templates": result["templates"]}, extra=extra)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                return response({"error": "登录已失效"}, 403)
            return response({"error": str(exc.detail)}, 409 if exc.status_code == 409 else 400)
