"""Bounded owner-only projections of existing durable operations, never raw payloads."""

from datetime import datetime
from uuid import UUID

from fastapi import HTTPException

from .account_signals import guard


def stamp(value):
    return value.isoformat() if isinstance(value, datetime) else None


def field(label, value):
    return {"label": label, "value": str(value)}


def count_fields(value):
    labels = {"records": "记录", "tradeOrders": "成交历史", "activities": "活动归档",
              "watchGroups": "自选分组", "fundTransactions": "资金来源", "userSettings": "本人设置",
              "profile": "个人资料", "siteSettings": "站点设置", "celebs": "公开人物"}
    return [field(labels[key], number) for key, number in (value if isinstance(value, dict) else {}).items()
            if key in labels and type(number) is int and 0 <= number <= 9007199254740991]


def item(identifier, title, status, label, created, *, request=None, message=None, fields=None,
         started=None, finished=None, target=None, task_id=None):
    return {"id": identifier, "title": title, "status": status, "statusLabel": label,
            "createdAt": stamp(created), "startedAt": stamp(started), "finishedAt": stamp(finished),
            "requestId": request, "target": target, "message": message, "fields": fields or [], "taskId": task_id}


class OperationHistory:
    def __init__(self, db):
        self.db = db

    async def read(self, who, kind, limit, offset):
        if kind not in {"import", "api", "sync", "backup"} or not 1 <= limit <= 50 or not 0 <= offset <= 100000:
            raise HTTPException(400, "任务记录查询无效")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await guard(conn, who)
            if kind == "backup" and who.role != "admin":
                raise HTTPException(403, "需要管理员权限")
            reader = getattr(self, "_" + kind)
            rows = await reader(conn, who.id, limit + 1, offset)
            return {"items": rows[:limit], "hasMore": len(rows) > limit}

    async def _import(self, conn, owner, limit, offset):
        rows = await (await conn.execute("""
            SELECT request_id,created_at,result->>'state' AS state,
                   result->'executed' AS executed,result->'counts' AS counts,
                   NULL::boolean AS preview_alive
            FROM personal_data_transfer_operations WHERE owner_id=%s
            UNION ALL
            SELECT p.request_id,p.created_at,'previewed',NULL,p.plan->'counts',
                   p.expires_at>clock_timestamp()
            FROM personal_data_transfer_previews p WHERE p.owner_id=%s
              AND NOT EXISTS(SELECT 1 FROM personal_data_transfer_operations o
                             WHERE o.owner_id=p.owner_id AND o.request_id=p.request_id)
            ORDER BY created_at DESC,request_id DESC LIMIT %s OFFSET %s
        """, (owner, owner, limit, offset))).fetchall()
        output = []
        for row in rows:
            rid = str(row["request_id"])
            state = row["state"]
            if state == "completed" and row["executed"] is True:
                status, label, message = "success", "导入已完成", "以原请求的导入回执为准"
            elif state == "closed":
                status, label, message = "idle", "已关闭未导入", "原请求已关闭，未执行导入"
            elif state == "previewed":
                status, label, message = ("confirm", "预览待确认", "仅保存预览，尚未导入") if row["preview_alive"] else (
                    "idle", "预览已过期", "预览已过期，尚未导入")
            else:
                status, label, message = "unknown", "结果待核对", "导入结果须按原请求回执核对"
            output.append(item("import:" + rid, "个人 JSON 导入", status, label, row["created_at"],
                               request=rid, message=message, fields=count_fields(row["counts"])))
        return output

    async def _api(self, conn, owner, limit, offset):
        # Grant metadata is historical authorization evidence, not live connectivity.
        # No password/security stamp/token table is selected or returned.
        rows = await (await conn.execute("""
            SELECT 'app' AS category,id::text AS id,client_id,device_name,created_at,expires_at,revoked_at,
                   expires_at<=clock_timestamp() AS expired
            FROM identity_app_grants WHERE user_id=%s
            UNION ALL
            SELECT 'client',id::text,client_id,device_name,created_at,expires_at,revoked_at,
                   expires_at<=clock_timestamp()
            FROM client_grants WHERE owner_id=%s
            ORDER BY created_at DESC,category,id DESC LIMIT %s OFFSET %s
        """, (owner, owner, limit, offset))).fetchall()
        output = []
        for row in rows:
            revoked, expired = row["revoked_at"] is not None, row["expired"]
            label = "已撤销" if revoked else "已过期" if expired else "授权已记录"
            fields = [field("客户端", row["client_id"]), field("授权到期", stamp(row["expires_at"]) or "未知")]
            if revoked:
                fields.append(field("撤销时间", stamp(row["revoked_at"])))
            output.append(item("api:" + row["category"] + ":" + row["id"], "App 授权" if row["category"] == "app" else "客户端授权",
                               "idle" if revoked or expired else "unknown", label, row["created_at"],
                               target=row["device_name"], fields=fields,
                               message="授权记录不代表当前设备在线；实际连接与权限须实时核对"))
        return output

    async def _sync(self, conn, owner, limit, offset):
        rows = await (await conn.execute("""
            SELECT 'watch' AS category,request_id,created_at,result->>'state' AS state
            FROM watch_display_operations WHERE owner_id=%s
            UNION ALL
            SELECT 'fees',request_id,NULL::timestamptz,result->>'state'
            FROM fee_state_operations WHERE owner_id=%s
            ORDER BY created_at DESC NULLS LAST,category,request_id DESC LIMIT %s OFFSET %s
        """, (owner, owner, limit, offset))).fetchall()
        output = []
        for row in rows:
            conflict = row["state"] == "conflict"
            known = row["state"] == "completed"
            label = "版本冲突" if conflict else "变更已记录" if known else "结果待核对"
            fields = [] if row["created_at"] is not None else [field("执行时间", "原回执未记录，保持未知")]
            output.append(item("sync:" + row["category"] + ":" + str(row["request_id"]),
                               "自选显示同步" if row["category"] == "watch" else "费率字段同步",
                               "partial" if conflict else "unknown", label, row["created_at"],
                               request=str(row["request_id"]), fields=fields,
                               message="其他设备已修改相同内容，须核对版本后处理" if conflict else
                               "本服务变更已记录；对端是否接收仍待核对" if known else "仅核对原请求，不自动重发"))
        return output

    async def _backup(self, conn, owner, limit, offset):
        rows = await (await conn.execute("""
            SELECT id,request_id,kind,status,error_code,created_at,started_at,finished_at,
                   result->>'backup_id' AS backup_id,result->'bytes' AS bytes,
                   result->'files_verified' AS files_verified
            FROM tasks WHERE owner_id=%s AND kind IN ('backup.create','backup.verify','backup.restore','backup.retention')
            ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s
        """, (owner, limit, offset))).fetchall()
        output = []
        titles = {"backup.create": "创建备份", "backup.verify": "校验备份", "backup.restore": "恢复备份",
                  "backup.retention": "备份保留策略"}
        states = {"queued": ("idle", "等待执行"), "running": ("running", "执行中"),
                  "cancel_requested": ("running", "等待取消"), "cancelled": ("idle", "已取消"),
                  "succeeded": ("success", "已完成"), "failed": ("failed", "失败")}
        for row in rows:
            status, label = states.get(row["status"], ("unknown", "待核对"))
            if row["error_code"] == "backup_retention_unknown":
                status, label = "unknown", "保留结果待核对"
            fields = [field("任务编号", row["id"])]
            try:
                bid = str(UUID(row["backup_id"])) if row["backup_id"] else None
            except (ValueError, TypeError, AttributeError):
                bid = None
            if bid:
                fields.append(field("备份文件", "alcor-" + bid + ".enc"))
            for key, name in (("bytes", "文件字节数"), ("files_verified", "已校验文件数")):
                value = row[key]
                if type(value) is int and 0 <= value <= 9007199254740991:
                    fields.append(field(name, value))
            message = "任务结果须按原请求回执核对"
            if row["status"] == "succeeded":
                message = {"backup.create": "备份文件已生成，未证明已下载到设备", "backup.verify": "备份校验完成",
                           "backup.restore": "已恢复到隔离目标，原连接授权不会自动恢复",
                           "backup.retention": "保留策略回执已保存，文件可用性须另行核对"}[row["kind"]]
            elif row["status"] == "failed":
                message = {
                    "backup_failed": "备份操作失败，请核对存储、备份工具与恢复目标",
                    "retry_budget_exhausted": "任务已达到执行预算，后续未自动继续",
                    "restore_requires_review": "实例恢复后原任务须重新核对，未自动重做",
                    "backup_retention_unknown": "备份保留操作结果未知，须核对原任务",
                }.get(row["error_code"], "任务执行失败，请查看原任务回执中的完整错误")
            output.append(item("backup:" + str(row["id"]), titles[row["kind"]], status, label, row["created_at"],
                               request=str(row["request_id"]), message=message, fields=fields,
                               started=row["started_at"], finished=row["finished_at"], task_id=str(row["id"])))
        return output
