"""Read-only route evidence for Fire's concrete API catalogue, including hidden callbacks."""

import hashlib
import json
import re
from pathlib import Path

from fastapi.routing import iter_route_contexts
from starlette.routing import compile_path


def normalized_path(value):
    value = re.sub(r"\[\[?\.\.\.[^/]+?\]\]?", "{path}", value)
    value = re.sub(r"\[[^/]+\]", "{id}", value)
    return re.sub(r"\{[^/]+\}", "{}", value)


def catalogue(app, *, document=None):
    # Routing/OpenAPI definitions are immutable within a running build. Cache only
    # this public contract; authentication is still checked for every HTTP read.
    signature = tuple((route.path, tuple(sorted(route.methods or []))) for route in iter_route_contexts(app.routes))
    cached = getattr(app.state, "fire_api_catalogue", None)
    if document is None and cached and cached[0] == signature:
        return cached[1]
    cacheable = document is None
    document = (
        document
        if document is not None
        else json.loads((Path(__file__).resolve().parents[2] / "contracts/fire-api-surface.json").read_text())
    )
    routes = []
    for route in iter_route_contexts(app.routes):
        path = route.path
        if not path or not path.startswith("/api/") or path == "/api/{path:path}":
            continue
        routes.append((path, compile_path(path)[0], set(route.methods or [])))
    contract_root = Path(__file__).resolve().parents[2] / "contracts"
    groups = json.loads((contract_root / "api-catalogue-groups.json").read_text())
    legacy_register = json.loads((contract_root / "migration-register.json").read_text())
    original_ids = {row['id'] for row in legacy_register['domains']}
    original_bindings = {}
    for operation in legacy_register['operations']:
        key = operation['method'], normalized_path(operation['path'])
        original_bindings.setdefault(key, set()).update(operation['feature_ids'])
    if any(not set(group['featureIds']) <= original_ids for group in groups):
        raise ValueError("API catalogue group has an unknown original feature ID")
    group_by_category = {name: (index, group) for index, group in enumerate(groups) for name in group['categories']}
    items, known = [], set()
    for item in document["operations"]:
        if "[[..." in item["path"]:
            continue
        # Concrete catalogue paths are checked against the actual method-aware router.
        # No request executes here and the unknown-API fallback never counts as evidence.
        candidate = re.sub(r"\[\.?\.?\.?([^/]+)\]", r"{\1}", item.get("upstream", item["path"]))
        candidate = re.sub(r"\{[^/]+\}", "catalogue-id", candidate)
        available = any(
            item["method"] in methods and regex.fullmatch(candidate) for _, regex, methods in routes
        )
        known.add((item["method"], normalized_path(item.get("upstream", item["path"]))))
        items.append(
            {
                **item,
                "backend_available": available,
                "status": "presentation"
                if item.get("owner") == "fire"
                else "connected"
                if available
                else "pending",
                "client_acceptance": "pending",
            }
        )
    for path, _, methods in routes:
        for candidate in (
            [path.replace("{version}", version) for version in ("1", "2")] if "{version}" in path else [path]
        ):
            for method in sorted(methods - {"HEAD", "OPTIONS"}):
                key = method, normalized_path(candidate)
                if key in known:
                    continue
                known.add(key)
                items.append(
                    {
                        "method": method,
                        "path": candidate,
                        "owner": "platform",
                        "backend_available": True,
                        "status": "connected",
                        "client_acceptance": "pending",
                    }
                )
    specification = app.openapi()
    descriptions = {}
    for path, methods in specification.get('paths', {}).items():
        for method, operation in methods.items():
            if method.upper() not in {'GET','POST','PUT','PATCH','DELETE'}:
                continue
            descriptions[(method.upper(),normalized_path(path))] = operation
    for item in items:
        operation = descriptions.get((item['method'],normalized_path(item.get('upstream',item['path']))), {})
        item['description'] = operation.get('description','')
        item['summary'] = operation.get('summary','')
        path = re.sub(r'^/api/(?:(?:v[12]|client|account|admin|fire)/)*', '', item['path'])
        first = path.split('/')[0]
        domains = {
            'auth':'账号与安全','session':'账号与安全','users':'账号与安全','profile':'个人资料',
            'records':'投资记录','portfolio':'投资分析','activities':'操作日志','activity':'操作日志',
            'trades':'交易与订单','orders':'交易与订单','trade-orders':'交易与订单','brokers':'券商与分组','watch-groups':'券商与分组',
            'assets':'素材与文件','asset-image':'素材与文件','upload':'素材与文件','resources':'素材与文件','files':'素材与文件',
            'quotes':'行情与市场','market':'行情与市场','stocks':'行情与市场','futu':'行情与市场',
            'feed':'动态与内容','celebrities':'名人持仓','celebs':'名人持仓',
            'openapi.json':'接口文档','meta':'系统管理','versions':'版本记录',
            'account':'账号与安全','passkeys':'账号与安全','totp':'账号与安全','password':'账号与安全',
            'email':'账号与安全','email-change':'账号与安全','login':'账号与安全','me':'账号与安全',
            'token':'应用与连接','authorize':'应用与连接','revoke':'应用与连接','permissions':'应用与连接',
            'clients':'应用与连接','connect':'应用与连接','consent':'应用与连接','grants':'应用与连接','config':'应用与连接',
            'devices':'设备管理','device-state':'设备管理','changes':'账户同步','state':'账户同步',
            'card-catalog':'卡面与卡包','card-wallet':'卡面与卡包','card-library':'卡面与卡包',
            'card-preferences':'卡面与卡包','card-recognition':'卡面识别',
            'cash':'资金与现金','cash-overview':'资金与现金','fund-sources':'资金与现金',
            'trading':'交易与订单','fees':'交易费用','financing':'融资与借贷',
            'broker-bindings':'券商账户','broker-metadata':'券商账户','broker-position-transfers':'券商账户',
            'broker-statements':'券商单据','broker-holding-source':'券商单据',
            'broker-icons':'券商与分组','shared-brokers':'券商与分组',
            'asset-instruments':'证券资料','asset-catalog':'素材与文件','asset-library':'素材与文件',
            'asset-sources':'素材与文件','shared-assets':'素材与文件','media':'素材与文件','media-aliases':'素材与文件',
            'attachment-import':'报告与附件','attachments':'报告与附件','resource-import':'素材与文件',
            'personal-font-import':'字体管理','personal-fonts':'字体管理',
            'notifications':'通知渠道','public-square':'动态与内容','agent-runtime':'后台任务',
            'close':'账号注销','closure':'账号注销','personal-data-transfer':'数据导入与导出',
            'financial-import':'数据导入与导出','legacy-financial':'数据导入与导出','watch-group-import':'券商与分组',
            'db':'系统管理','system-operations':'系统管理','operation-history':'操作日志',
            'operational-sources':'数据来源','provider-operations':'数据来源','reference':'基础资料',
            'private-runtime-settings':'设置','site-settings':'设置','preferences':'个人偏好',
            'broker-accounts':'券商账户','account-assets':'账户资产','account-sync':'账户同步',
            'cards':'卡面与卡包','personal-profile':'个人资料','price-alerts':'价格提醒',
            'funds':'基金','simple-ledger':'简易账本','simple-app':'简易账本',
            'kline':'行情与图表','charts':'行情与图表','chart-series':'行情与图表',
            'index-kline':'行情与图表','kline-sessions':'行情与图表',
            'company-profile':'证券资料','stock-detail':'证券资料','financials':'证券资料',
            'earnings':'财报与股息','financial-reports':'财报与股息','dividends':'财报与股息',
            'indices':'行情与市场','market-ranking':'行情与市场','top-stocks':'行情与市场',
            'market-calendar':'市场日历','rates':'汇率','search':'证券搜索',
            'quote-subscriptions':'行情订阅','quote-pool':'行情订阅','ticker':'行情与市场',
            'resource-library':'素材与文件','system-assets':'素材与文件','fonts':'素材与文件',
            'managed-upload':'素材与文件','upload-files':'素材与文件','pwa-icon':'素材与文件',
            'site-favicon':'素材与文件','private-reports':'报告与附件','countries':'国家与地区',
            'portfolio-series':'投资分析','overview':'投资分析','data':'数据管理',
            'social-channels':'通知渠道','trading-square':'动态与内容',
            'app-packages':'应用与连接','app-state':'应用与连接','connections':'应用与连接',
            'clipboard':'剪贴板','request-logs':'请求日志','api-docs':'接口文档',
            'fire-settings':'设置','settings':'设置','system':'系统管理','health':'系统管理','tasks':'后台任务',
            'deployment':'发布管理','deploy-status':'发布管理','backups':'备份与恢复','backup':'备份与恢复','database-migration':'备份与恢复',
        }
        item['featureIds'] = sorted(original_bindings.get((item['method'], normalized_path(item.get('upstream', item['path']))), set()))
        item['subcategory'] = domains.get(first, '其他接口')
        order, group = group_by_category[item['subcategory']]
        item['category'] = group['name']
        item['categoryOrder'] = order
        item['categoryNumber'] = order + 1
        item['subcategoryOrder'] = group['categories'].index(item['subcategory'])
        item['categoryFeatureIds'] = group['featureIds']
        item['parameters'] = operation.get('parameters',[])
        item['requestBody'] = operation.get('requestBody')
        item['responses'] = operation.get('responses',{})
    result = {
        "revision": document["revision"],
        "schemas": specification.get('components', {}).get('schemas', {}),
        "items": items,
        "retirements": document.get("retirements", []),
        "summary": {
            "total": len(items),
            **{
                key: sum(item["status"] == key for item in items)
                for key in ("pending", "connected", "presentation")
            },
            "retired": len(document.get("retirements", [])),
        },
    }

    result["etag"] = 'W/"' + hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest() + '"'
    if cacheable:
        app.state.fire_api_catalogue = (signature, result)
    return result


async def read_catalogue(app):
    """Generate immutable source metadata off-loop after caller authorization."""
    import asyncio

    task = getattr(app.state, 'fire_api_catalogue_task', None)
    if task is None:
        task = asyncio.create_task(asyncio.to_thread(catalogue, app))
        app.state.fire_api_catalogue_task = task

        def completed(finished):
            if getattr(app.state, 'fire_api_catalogue_task', None) is finished:
                app.state.fire_api_catalogue_task = None
            # A disconnected sole reader must not leave an unhandled error.
            if not finished.cancelled():
                finished.exception()

        task.add_done_callback(completed)
    return await asyncio.shield(task)
