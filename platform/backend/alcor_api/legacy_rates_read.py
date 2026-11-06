"""Legacy snapshot reads over the PG FX authority; never refresh or invent quotes."""

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from .activity_api import legacy_activity_user
from .legacy_identity import assert_native_origin, native_identity


async def read_snapshot(request, version, settings, db, service):
    headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization",
               "X-Alcor-Rates-Refresh-Method": "POST", "X-Alcor-Rates-Automatic-Refresh": "false"}
    if request.query_params.get("refresh") == "1":
        headers["X-Alcor-Rates-Refresh-State"] = "explicit_post_required"
        headers["Link"] = '</api/reference/rates/refresh>; rel="refresh"'
    # The old Web and v1 read do not check Origin or authenticate native tokens.
    # v2's public policy still validates an explicitly supplied App credential.
    if version == 2:
        try:
            assert_native_origin(request, settings)
            if "authorization" in request.headers:
                value = request.headers["authorization"]
                if not value.startswith("Bearer "):
                    raise HTTPException(401, "需要有效的 App 连接")
                _,grant=await native_identity(request, db)
                from .native_app_auth import CLIENT
                if grant["client_id"]!=CLIENT:raise HTTPException(401,"连接已失效，请重新连接")
        except HTTPException as exc:
            code = 40102 if exc.detail == "连接已失效，请重新连接" else exc.status_code * 100 + 1
            return JSONResponse(
                {"code": code, "message": str(exc.detail)},
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store"},
            )
        headers["X-Alcor-API-Version"] = "2"
    elif version is None and await legacy_activity_user(db, request) is None:
        return JSONResponse({"error": "未登录"}, status_code=401)
    try:
        snapshot = await service.snapshot()
        if snapshot.get("state")=="retained_unavailable":
            raise HTTPException(503,"汇率原件暂不可验证")
        # USD identity is mathematical, not a fabricated external observation.
        # The old built-in fallback currencies deliberately stay unavailable.
        value = {key: snapshot[key] for key in ("base", "rates", "quoted", "updatedAt")}
        return JSONResponse(
            value if version is None else {"code": 0, "message": "ok", "data": value}, headers=headers
        )
    except Exception:  # noqa: BLE001 -- old snapshot errors are a fixed, secret-free upstream response
        message = "获取汇率失败，请稍后重试"
        return JSONResponse(
            {"error": message} if version is None else {"code": 50002, "message": message},
            status_code=502,
            headers={"Cache-Control": "no-store", **({"X-Alcor-API-Version": "2"} if version == 2 else {})},
        )
