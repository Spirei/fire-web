import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser } from "@/lib/auth";
import { deleteRecord, updateRecord, parseMarket, toNumberOrEmpty } from "@/lib/store";
import type { RecordInput } from "@/lib/types";
import { fail, ok } from "@/lib/api";
import { validateRecordFields } from "@/lib/recordValidation";

/** v1 更新持仓记录 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const { id } = await params;
  const body = await readJsonBody(request).catch(() => null);
  if (!body) return fail(40002, "无效的请求体", 400);
  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim();
  const price = toNumberOrEmpty(body.price);
  const cost = toNumberOrEmpty(body.cost);
  const qty = toNumberOrEmpty(body.qty);
  const validationError = validateRecordFields(name, code, price, qty);
  if (validationError) return fail(40001, validationError, 400);
  const input: RecordInput = {
    name,
    code,
    market: parseMarket(String(body.market ?? "OTHER")),
    price,
    cost,
    qty,
    group: String(body.group ?? "").trim().slice(0, 100),
    note: String(body.note ?? "").trim().slice(0, 500),
    source: String(body.source ?? "").trim().slice(0, 50)
  };
  const record = updateRecord(id, user.id, input);
  if (!record) return fail(40401, "记录不存在", 404);
  return ok(record);
}

/** v1 删除持仓记录 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(_request);
  if (!user) return fail(40101, "未登录", 401);
  const { id } = await params;
  if (!deleteRecord(id, user.id)) return fail(40401, "记录不存在", 404);
  return ok({ deleted: true });
}
