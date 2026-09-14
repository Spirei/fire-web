import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { runAssistantAction } from "@/lib/assistantActions";
import { deleteOrder, placeOrder } from "@/lib/orders";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { assignRecordsGroup, createWatchGroup, deleteWatchGroup } from "@/lib/watchGroupsStore";

const ACTION_TTL_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`assistant-action:${clientIp(request)}:${user.id}`, 30, 60_000) || !rateLimitGlobal("assistant-action", 180, 60_000)) {
    return fail(42901, "操作过于频繁，请稍后再试", 429);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(40002, "无效的请求体", 400);
  const actionId = String(body.actionId || "");
  const type = String(body.type || "");
  const createdAt = Date.parse(String(body.createdAt || ""));
  if (!/^(?:aa|au)-[a-f0-9]{24}$/.test(actionId)) return fail(40001, "操作标识无效，请重新生成预览", 400);
  const isUndo = type.startsWith("undo_");
  if ((isUndo && !actionId.startsWith("au-")) || (!isUndo && !actionId.startsWith("aa-"))) {
    return fail(40001, "操作标识与操作类型不一致，请重新生成预览", 400);
  }
  if (!Number.isFinite(createdAt) || createdAt > Date.now() + 60_000 || Date.now() - createdAt > ACTION_TTL_MS) {
    return fail(40001, "操作预览已过期，请重新输入指令", 400);
  }

  try {
    if (type === "create_group") {
      const name = String(body.name || "").trim();
      if (!name || name.length > 30) return fail(40001, "分组名称需为 1-30 个字符", 400);
      const response = runAssistantAction({ userId: user.id, actionId, actionType: type, payload: { name }, execute: () => ({ group: createWatchGroup(user.id, name), executedAt: new Date().toISOString() }) });
      return ok({ ...response.result, replayed: response.replayed });
    }
    if (type === "assign_group") {
      const ids = Array.isArray(body.recordIds)
        ? [...new Set(body.recordIds.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 100))]
        : [];
      const groupId = String(body.groupId || "").trim();
      if (!ids.length || ids.length > 2000 || !groupId) return fail(40001, "分组或股票列表无效", 400);
      const response = runAssistantAction({ userId: user.id, actionId, actionType: type, payload: { ids, groupId }, execute: () => ({ updated: assignRecordsGroup(user.id, ids, groupId), executedAt: new Date().toISOString() }) });
      return ok({ ...response.result, replayed: response.replayed });
    }
    if (type === "trade") {
      const recordId = String(body.recordId || "").trim();
      const side: "buy" | "sell" | null = body.side === "buy" || body.side === "sell" ? body.side : null;
      const qty = Number(body.qty), price = Number(body.price), fees = Number(body.fees ?? 0);
      if (!recordId || !side || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fees) || fees < 0) {
        return fail(40001, "请填写有效的方向、数量、价格和费用", 400);
      }
      const payload = { recordId, side, qty, price, fees };
      const response = runAssistantAction({
        userId: user.id, actionId, actionType: type, payload,
        execute: () => ({ ...placeOrder({ userId: user.id, ...payload, tradedAt: new Date().toISOString(), note: "由账户助手录入", mode: "record" }), executedAt: new Date().toISOString() })
      });
      return ok({ ...response.result, replayed: response.replayed });
    }
    if (type === "undo_delete_group") {
      const groupId = String(body.groupId || "").trim();
      if (!groupId) return fail(40001, "分组标识无效", 400);
      const response = runAssistantAction({ userId: user.id, actionId, actionType: type, payload: { groupId }, execute: () => ({ deleted: deleteWatchGroup(user.id, groupId) }) });
      return ok({ ...response.result, replayed: response.replayed });
    }
    if (type === "undo_restore_groups") {
      const previous = Array.isArray(body.previous) ? body.previous.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>, id = String(row.id || "").trim(), groupId = String(row.groupId || "").trim();
        return id && id.length <= 100 && groupId.length <= 100 ? [{ id, groupId }] : [];
      }).slice(0, 2000) : [];
      if (!previous.length) return fail(40001, "原分组数据无效", 400);
      const response = runAssistantAction({ userId: user.id, actionId, actionType: type, payload: { previous }, execute: () => {
        const grouped = new Map<string, string[]>();
        previous.forEach((item) => grouped.set(item.groupId, [...(grouped.get(item.groupId) || []), item.id]));
        let updated = 0;
        for (const [groupId, ids] of grouped) updated += assignRecordsGroup(user.id, ids, groupId);
        return { updated };
      } });
      return ok({ ...response.result, replayed: response.replayed });
    }
    if (type === "undo_delete_order") {
      const orderId = String(body.orderId || "").trim();
      if (!orderId) return fail(40001, "订单标识无效", 400);
      const response = runAssistantAction({ userId: user.id, actionId, actionType: type, payload: { orderId }, execute: () => deleteOrder({ userId: user.id, orderId }) });
      return ok({ ...response.result, replayed: response.replayed });
    }
    return fail(40001, "不支持的助手操作", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}
