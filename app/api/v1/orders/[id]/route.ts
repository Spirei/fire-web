import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { cancelOrder, deleteOrder, updateOrder } from "@/lib/orders";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  try {
    const { id } = await params;
    return ok(cancelOrder({ userId: user.id, orderId: id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "撤单失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const body = await request.json().catch(() => null);
  if (!body) return fail(40002, "无效的请求体", 400);
  const side = body.side === "buy" || body.side === "sell" || body.side === "dividend" ? body.side : null;
  const qty = Number(body.qty);
  const price = Number(body.price);
  const fees = body.fees === "" || body.fees == null ? 0 : Number(body.fees);
  if (!side || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fees) || fees < 0) {
    return fail(40001, "请填写有效的方向、数量、价格和费用", 400);
  }
  try {
    const { id } = await params;
    return ok(updateOrder({
      userId: user.id,
      orderId: id,
      side,
      qty,
      price,
      fees,
      tradedAt: body.tradedAt ? String(body.tradedAt) : undefined,
      note: String(body.note || "")
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "订单更正失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  try {
    const { id } = await params;
    return ok(deleteOrder({ userId: user.id, orderId: id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "订单删除失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}
