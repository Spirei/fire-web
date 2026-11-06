from typing import Annotated
from uuid import UUID

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field

from .fee_plans import FeePlans
from .security import Identity, identity

Member = Annotated[Identity, Depends(identity)]


class Submit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict
    preview: str = Field(min_length=1, max_length=128)


def mount_fees(app, db):
    service = FeePlans(db)

    @app.get("/api/fees/plans")
    async def plans(who: Member, accountId: str):
        return await service.list(who, accountId)

    @app.post("/api/fees/plans/preview")
    async def preview(data: dict, who: Member):
        return await service.preview(who, data)

    @app.post("/api/fees/plans/operations")
    async def submit(data: Submit, who: Member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/fees/plans/operations/{request_id}")
    async def receipt(request_id: UUID, who: Member):
        return await service.receipt(who, str(request_id))

    return service


def mount_fee_repairs(app, db):
    from .fee_repairs import FeeRepairs

    service = FeeRepairs(db)

    @app.get("/api/fees/repairs")
    async def snapshot(who: Member, brokerAccountId: str):
        return await service.snapshot(who, brokerAccountId)

    @app.post("/api/fees/repairs/preview")
    async def preview(data: dict, who: Member):
        return await service.preview(who, data)

    @app.post("/api/fees/repairs/operations")
    async def submit(data: Submit, who: Member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/fees/repairs/operations/{request_id}")
    async def receipt(request_id: UUID, who: Member):
        return await service.receipt(who, request_id)

    return service


def mount_legacy_fee_repairs(app, db):
    from fastapi import HTTPException, Request
    from fastapi.responses import JSONResponse

    from .fee_repairs import FeeRepairs
    from .legacy_identity import assert_native_origin, native_identity

    service = FeeRepairs(db)
    numeric = {
        "qty",
        "quantity",
        "price",
        "amount",
        "fees",
        "oldFees",
        "newFees",
        "feeDelta",
        "rate",
        "before",
        "after",
        "delta",
        "brokerBefore",
        "brokerAfter",
        "brokerDelta",
        "unallocatedDelta",
        "externalFlow",
        "beforeCost",
        "afterCost",
        "beforeRealizedPnl",
        "afterRealizedPnl",
    }

    def legacy(value, key=None):
        if isinstance(value, dict):
            return {k: legacy(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [legacy(v) for v in value]
        return float(value) if key in numeric and isinstance(value, str) else value

    async def operation_response(request, version, action):
        try:
            if version not in (1, 2):
                raise HTTPException(404, "接口不存在")
            assert_native_origin(request, db.settings)
            who, _ = await native_identity(
                request, db, "orders.read" if action == "snapshot" else "orders.write"
            )
            header = request.headers.get("x-alcor-trade-fees")
            if header not in (None, "details-v1"):
                raise HTTPException(400, "费用读取版本无效")
            if action == "snapshot":
                if (
                    len(request.query_params) != 1
                    or len(request.query_params.getlist("brokerAccountId")) != 1
                ):
                    raise HTTPException(400, "须指定本人券商账户")
                value = await service.snapshot(who, request.query_params["brokerAccountId"])
                if not value["ordersComplete"]:
                    raise HTTPException(409, "旧原账清单未导入完整，请先核对原始订单范围")
                required = (
                    "market",
                    "code",
                    "qty",
                    "price",
                    "amount",
                    "fees",
                    "tradedAt",
                    "revision",
                    "recordRevision",
                )
                if any(any(item.get(key) is None for key in required) for item in value["items"]):
                    raise HTTPException(409, "旧原账必要字段未知，不能用零值替代")
            else:
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                raw = await request.body()
                if len(raw) > 131072:
                    raise HTTPException(413, "请求内容超过上限")
                import json

                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise HTTPException(400, "费用请求须为对象")
                selected_service=app.state.actual_fee_confirmations if "confirmations" in body else service
                if action == "preview":
                    value = await selected_service.preview(who, body)
                else:
                    proof = body.pop("previewRevision", None)
                    if not isinstance(proof, str):
                        raise HTTPException(400, "须提供预览版本")
                    try:
                        await service.trading.receipt(who, UUID(body.get("requestId", "")))
                    except HTTPException as missing:
                        if missing.status_code != 404:
                            raise
                    else:
                        return JSONResponse(
                            {"code": 40901, "message": "UUID已使用，请查询原回执", "data": None},
                            status_code=409,
                        )
                    value = await selected_service.submit(who, body, proof)
                    if value["state"] == "failed":
                        return JSONResponse(
                            {"code": value["code"], "message": value["message"], "data": None},
                            status_code=value["status"],
                        )
            return JSONResponse(
                {"code": 0, "message": "ok", "data": legacy(value)},
                headers={
                    "Vary": "X-Alcor-Trade-Fees",
                    **({"X-Alcor-Trade-Fees": "details-v1"} if header else {}),
                },
            )
        except (HTTPException, ValueError, TypeError, KeyError) as error:
            status = error.status_code if isinstance(error, HTTPException) else 400
            return JSONResponse(
                {
                    "code": status * 100 + 1,
                    "message": str(error.detail) if isinstance(error, HTTPException) else "费用请求无效",
                    "data": None,
                },
                status_code=status,
            )

    async def response(request, version, action):
        result = await operation_response(request, version, action)
        if version in (1, 2):
            result.headers["X-Alcor-API-Version"] = str(version)
        return result

    @app.get("/api/v{version}/account-assets/fee-repairs")
    async def snapshot(version: int, request: Request):
        return await response(request, version, "snapshot")

    @app.post("/api/v{version}/account-assets/fee-repairs/preview")
    async def preview(version: int, request: Request):
        return await response(request, version, "preview")

    @app.post("/api/v{version}/account-assets/fee-repairs/submissions")
    async def submit(version: int, request: Request):
        return await response(request, version, "submit")

    handlers = getattr(app.state, "legacy_asset_operation_adapters", {})
    if "historical_fee_repair" in handlers:
        raise RuntimeError("duplicate historical fee adapter")
    handlers["historical_fee_repair"] = legacy
    handlers["actual_fee_confirmation"] = legacy
    app.state.legacy_asset_operation_adapters = handlers

    @app.get("/api/v{version}/account-assets/operations/{request_id}")
    async def operation_receipt(version: int, request_id: UUID, request: Request):
        try:
            if version not in (1, 2):
                raise HTTPException(404, "接口不存在")
            assert_native_origin(request, db.settings)
            who, _ = await native_identity(request, db, "portfolio.read")
            header = request.headers.get("x-alcor-trade-fees")
            if header not in (None, "details-v1"):
                raise HTTPException(400, "费用读取版本无效")
            try:
                result = await service.trading.receipt(who, request_id)
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                resolvers = [getattr(app.state, name, None) for name in ('legacy_native_orders', 'internal_order_observations', 'legacy_asset_authority', 'legacy_cash_commands')]
                value = None
                for authority in resolvers:
                    if authority is None:
                        continue
                    try:
                        value = await authority.receipt(who, request_id)
                        if value.get('kind') in ('legacy_internal_orders','internal_order_observation'):value=value['legacyReceipt']
                    except HTTPException as candidate:
                        if candidate.status_code != 404:
                            raise
                    else:
                        break
                if value is None:
                    raise
            else:
                adapter = app.state.legacy_asset_operation_adapters.get(result.get("kind"))
                if adapter is None:
                    raise HTTPException(404, "该操作尚未适配")
                value=adapter(result)
                if result.get('legacyReceipt') is not None:
                    from .legacy_trading_snapshot import fee_transport
                    value=fee_transport(value,header=='details-v1')
            return JSONResponse(
                {"code": 0, "message": "ok", "data": value},
                headers={
                    "Cache-Control": "no-store",
                    "X-Alcor-API-Version": str(version),
                    "Vary": "X-Alcor-Trade-Fees",
                    **({"X-Alcor-Trade-Fees": "details-v1"} if header else {}),
                },
            )
        except HTTPException as error:
            return JSONResponse(
                {"code": error.status_code * 100 + 1, "message": str(error.detail), "data": None},
                status_code=error.status_code,
                headers={"X-Alcor-API-Version": str(version),"Cache-Control":"no-store, private", "Vary":"Cookie, Authorization, X-Alcor-Trade-Fees",
                         **(error.headers or {}), **({'X-Alcor-Retire-Context':'true'} if error.status_code in (401,403) else {})} if version in (1, 2) else {},
            )


def mount_source_attributions(app, db):
    from .fee_source_inventory import FeeSourceAttributions

    service = FeeSourceAttributions(db)

    @app.get('/api/fees/source-attributions')
    async def listing(who:Member,limit:int=100,offset:int=0,sourceRevision:int|None=None,inventoryRevision:str|None=None):
        return await service.listing(who,limit=limit,offset=offset,source_revision=sourceRevision,inventory_revision=inventoryRevision)

    @app.post("/api/fees/source-attributions/preview")
    async def preview(data: dict, who: Member):
        return await service.preview(who, data)

    @app.post("/api/fees/source-attributions/operations")
    async def submit(data: Submit, who: Member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/fees/source-attributions/operations/{request_id}")
    async def receipt(request_id: UUID, who: Member):
        return await service.receipt(who, request_id)

    return service
