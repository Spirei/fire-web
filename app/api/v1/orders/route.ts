import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { listOrders, placeOrder, settlePendingOrders } from "@/lib/orders";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  await settlePendingOrders(user.id);
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("scope") || "all";
  const scope = raw === "today" || raw === "history" ? raw : "all";
  const limit = Math.min(5000, Math.max(1, Number(searchParams.get("limit")) || 200));
  const recordId = String(searchParams.get("recordId") || "").trim();
  return ok({ orders: listOrders(user.id, scope, limit, recordId || undefined), scope, recordId: recordId || null });
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const body = await request.json().catch(() => null);
  if (!body) return fail(40002, "无效的请求体", 400);
  const recordId = String(body.recordId || "").trim();
  const side = body.side === "buy" || body.side === "sell" || body.side === "dividend" ? body.side : null;
  const qty = Number(body.qty);
  const price = Number(body.price);
  const fees = body.fees === "" || body.fees == null ? 0 : Number(body.fees);
  if (!recordId || !side || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fees) || fees < 0) {
    return fail(40001, "请填写有效的方向、数量、价格和费用", 400);
  }
  try {
    return ok(placeOrder({
      userId: user.id,
      recordId,
      side,
      qty,
      price,
      fees,
      orderType: body.orderType,
      tif: body.tif,
      expiresAt: body.expiresAt ? String(body.expiresAt) : null,
      session: body.session ? String(body.session) : "",
      tradedAt: body.tradedAt ? String(body.tradedAt) : undefined,
      note: String(body.note || "")
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "订单执行失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}
