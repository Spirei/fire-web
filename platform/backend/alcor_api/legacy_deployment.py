"""Old deployment paths over the same platform authorization, PG receipts and updater.

Writes deliberately require caller UUID/CAS/target proof; the pre-migration UI
must be adapted before it can issue deployment commands.
"""

import asyncio
import re
from functools import wraps
from uuid import UUID

from fastapi import HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import ValidationError

from . import deployment_config as configuration
from . import deployment_observations as observations
from . import deployments
from .admin_verification import VerificationInput, verify_admin_access
from .legacy_identity import body, web_identity
from .security import lock_mutation_identity

PREFIX = "/api/deploy-status"


def protocol(endpoint):
    @wraps(endpoint)
    async def wrapped(*args, **kwargs):
        try:
            value = await endpoint(*args, **kwargs)
            if isinstance(value, Response):
                value.headers["Cache-Control"] = "no-store"
                return value
            return JSONResponse(jsonable_encoder(value), headers={"Cache-Control": "no-store"})
        except ValidationError:
            return JSONResponse(
                {"error": "请求参数无效；操作须提供原请求编号和目标版本"},
                status_code=422,
                headers={"Cache-Control": "no-store"},
            )
        except HTTPException as exc:
            return JSONResponse(
                {"error": str(exc.detail)},
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store", **(exc.headers or {})},
            )
        except Exception:  # noqa: BLE001 - legacy protocol boundary never exposes tokens or provider details
            return JSONResponse(
                {"error": "发布服务暂时不可用，请核对原请求回执"},
                status_code=503,
                headers={"Cache-Control": "no-store"},
            )

    return wrapped


async def admin(request, db):
    authorization = request.headers.get("authorization")
    bearer = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else None
    # Preserve the old Web-session bearer, without treating App/new-Web tokens
    # as this protocol's administrator or falling back to a residual Cookie.
    if authorization is not None and (len(request.headers.getlist("authorization")) != 1
                                      or bearer is None or not re.fullmatch(r"[a-fA-F0-9]{64}", bearer)):
        raise HTTPException(403, "需要管理员权限")
    try:
        who, _, _ = await web_identity(request, db, allow_legacy_bearer=True, web_bearer_only=True)
    except HTTPException as exc:
        raise HTTPException(403, "需要管理员权限") from exc
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    async with db.connection() as conn:
        await lock_mutation_identity(conn, who)
    return who


def require_uuid(data):
    identifier = data.get("request_id")
    if not isinstance(identifier, str):
        raise HTTPException(422, "操作须提供原请求编号 request_id")
    try:
        if str(UUID(identifier)) != identifier:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "原请求编号无效") from None
    return identifier


def mount_legacy_deployment(app, settings, db):
    @app.get(PREFIX)
    @protocol
    async def status(request: Request):
        who = await admin(request, db)
        state = await deployments.status(request, who)
        runs, heatmap = None, None
        run_error, heatmap_error = None, None
        if state["configured"]:
            history, activity = await asyncio.gather(
                observations.history_page(request, who, page=1, per_page=100),
                observations.activity(request, who),
                return_exceptions=True,
            )
            if isinstance(history, BaseException):
                run_error = "运行记录暂不可用"
            else:
                runs = [
                    {
                        "id": run["id"],
                        "name": run["name"],
                        "title": run["title"],
                        "sha": run["sha"][:7],
                        "status": run["status"],
                        "conclusion": run["conclusion"],
                        "event": run["event"],
                        "workflowPath": run["workflow_path"],
                        "publication": run["publication"],
                        "startedAt": run["started_at"],
                        "updatedAt": run["updated_at"],
                        "url": run["url"],
                    }
                    for run in history["items"]
                ]
            if isinstance(activity, BaseException):
                heatmap_error = "提交记录暂不可用"
            else:
                heatmap = activity
        # Provider reads can outlive a role/session revocation; do not deliver a
        # snapshot authorized only by the earlier check.
        await admin(request, db)
        release, source = state["release"], state["source"]
        source_sha = source["sha"] if source else None
        release_sha = release.revision if release else None
        runtime_sha = state["running_revision"]
        build = state.get("build")
        progress = (
            None
            if not build
            else {
                "id": build["id"],
                "status": build["status"],
                "conclusion": build["conclusion"],
                "sha": build["sha"][:7],
                "startedAt": build["started_at"],
                "updatedAt": build["updated_at"],
                "url": build["url"],
                "jobs": None
                if state["jobs"] is None
                else [
                    {
                        "id": job["id"],
                        "name": job["name"],
                        "status": job["status"],
                        "conclusion": job["conclusion"],
                        "startedAt": job["started_at"],
                        "completedAt": job["completed_at"],
                        "url": None,
                        "steps": [
                            {
                                "number": step["number"],
                                "name": step["name"],
                                "status": step["status"],
                                "conclusion": step["conclusion"],
                                "startedAt": step["started_at"],
                                "completedAt": step["completed_at"],
                            }
                            for step in job["steps"]
                        ],
                    }
                    for job in state["jobs"]
                ],
            }
        )
        return {
            "repository": state["repository"],
            "packageName": state["repository"].split("/")[-1] or None,
            "workflowRunCount": history.get("total")
            if state["configured"] and not isinstance(history, BaseException)
            else None,
            "runs": runs,
            "runsError": run_error,
            "heatmap": heatmap["counts"] if heatmap else None,
            "heatmapComplete": heatmap["complete"] if heatmap else False,
            "heatmapError": heatmap_error,
            "imageProgress": progress,
            "source": {**source, "shortSha": source_sha[:7]} if source else None,
            "image": {
                "latestSuccessfulSha": release_sha,
                "latestSuccessfulShortSha": release_sha[:7] if release_sha else None,
                "latestSuccessfulAt": None,
                "latestSuccessfulUrl": None,
                "matchesMain": release_sha == source_sha if release_sha and source_sha else None,
            },
            "runtime": {
                "sha": runtime_sha or "unknown",
                "shortSha": runtime_sha[:7] if runtime_sha else "unknown",
                "ready": state["runtime_ready"],
                "matchesImage": state["matches_release"] if runtime_sha and release_sha else None,
                "matchesMain": state["runtime_ready"] and runtime_sha == source_sha if runtime_sha and source_sha else None,
            },
            "checkedAt": state["checked_at"],
            "configured": state["configured"],
            "sourceError": state["source_error"],
            "releaseError": state["release_error"],
        }

    @app.get(PREFIX + "/config")
    @protocol
    async def config(request: Request):
        return await configuration.read_config(request, await admin(request, db))

    @app.put(PREFIX + "/config")
    @protocol
    async def save(request: Request):
        who = await admin(request, db)
        data = await body(request, ("request_id", "revision", "repository", "token", "clearToken"))
        require_uuid(data)
        if "revision" not in data:
            raise HTTPException(422, "保存须提供读取到的配置 revision")
        data["clear_token"] = data.pop("clearToken", False)
        return await configuration.save_config(configuration.ConfigInput.model_validate(data), request, who)

    @app.delete(PREFIX + "/config")
    @protocol
    async def disconnect(request: Request):
        who = await admin(request, db)
        data = await body(request, ("request_id", "revision"))
        require_uuid(data)
        result = await configuration.disconnect(
            configuration.DisconnectInput.model_validate(data), request, who
        )
        return {
            "ok": True,
            **result,
            "request_id": data["request_id"],
            "receiptUrl": PREFIX + "/config/receipts/" + data["request_id"],
        }

    @app.get(PREFIX + "/container-update")
    @protocol
    async def updater(request: Request):
        await admin(request, db)
        effective = await configuration.effective(request)
        from .deployment_watchtower import probe

        runner = await asyncio.to_thread(probe, effective)
        await admin(request, db)
        return {
            "available": runner["configured"] and runner["online"],
            "configured": runner["configured"],
            "reachable": runner["online"],
            "observedAt": runner["observed_at"],
            "reason": runner["reason"],
        }

    @app.post(PREFIX)
    @protocol
    async def build(request: Request):
        who = await admin(request, db)
        data = await body(request, ("request_id",))
        require_uuid(data)
        result = await deployments.build_source(deployments.BuildInput.model_validate(data), request, who)
        return JSONResponse(
            jsonable_encoder(
                {
                    "ok": result["status"] == "submitted",
                    "pending": result["status"] != "submitted",
                    "request_id": result["request_id"],
                    "status": result["status"],
                    "receiptUrl": PREFIX + "/builds/" + str(result["request_id"]),
                }
            ),
            status_code=202,
        )

    @app.post(PREFIX + "/container-update")
    @protocol
    async def update(request: Request):
        who = await admin(request, db)
        data = await body(request, ("request_id", "release"))
        require_uuid(data)
        result = await deployments.submit(deployments.UpdateInput.model_validate(data), request, who)
        return JSONResponse(
            jsonable_encoder(
                {
                    "ok": result["status"] == "succeeded",
                    "pending": result["status"] in {"queued", "running", "unknown"},
                    **result,
                    "receiptUrl": PREFIX + "/requests/" + str(result["request_id"]),
                }
            ),
            status_code=202,
        )

    @app.get(PREFIX + "/builds/{request_id}")
    @protocol
    async def build_receipt(request_id: UUID, request: Request):
        return await deployments.build_receipt(request_id, request, await admin(request, db))

    @app.get(PREFIX + "/requests/{request_id}")
    @protocol
    async def update_receipt(request_id: UUID, request: Request):
        return await deployments.receipt(request_id, request, await admin(request, db))

    @app.get(PREFIX + "/config/receipts/{request_id}")
    @protocol
    async def configuration_receipt(request_id: UUID, request: Request):
        return await configuration.config_receipt(request_id, request, await admin(request, db))

    @app.post(PREFIX + "/reauthenticate", status_code=204)
    @protocol
    async def reauthenticate(request: Request):
        who = await admin(request, db)
        data = VerificationInput.model_validate(await body(request, ("password", "code")))
        return await verify_admin_access(data, request, who, "deployment")

    @app.get(PREFIX + "/github/start")
    @protocol
    async def oauth_start(request: Request):
        who = await admin(request, db)
        return await configuration.oauth_start_for(
            request, who, callback_path=PREFIX + "/github/callback", cookie_name="alcor_legacy_deploy_oauth"
        )

    @app.get(PREFIX + "/github/callback", include_in_schema=False)
    async def oauth_callback(request: Request):
        try:
            who = await admin(request, db)
        except HTTPException:
            return RedirectResponse(
                "/deploy-status?github_error=admin_session_required",
                status_code=303,
                headers={"Cache-Control": "no-store"},
            )
        state, code = request.query_params.get("state", ""), request.query_params.get("code", "")
        if len(state) > 128 or len(code) > 512:
            return RedirectResponse(
                "/deploy-status?github_error=invalid_oauth_callback",
                status_code=303,
                headers={"Cache-Control": "no-store"},
            )
        return await configuration.oauth_callback_for(
            request,
            state,
            code,
            callback_path=PREFIX + "/github/callback",
            cookie_name="alcor_legacy_deploy_oauth",
            clients=("legacy-web",),
            session_hash=who.token_hash,
        )
