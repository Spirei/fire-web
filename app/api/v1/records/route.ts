import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser } from "@/lib/auth";
import { createRecord, listRecords, logActivity, parseMarket, toNumberOrEmpty } from "@/lib/store";
import type { RecordInput } from "@/lib/types";
import { fail, ok, pageMeta, parsePage } from "@/lib/api";
import { validateRecordFields } from "@/lib/recordValidation";

/** v1 持仓记录列表（统一分页，按市场/分组过滤） */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "").toUpperCase();
  const group = (searchParams.get("group") || "").trim();
  let records = listRecords(user.id);
  if (market) records = records.filter((r) => r.market === market);
  if (group) records = records.filter((r) => r.group === group);
  const { page, pageSize } = parsePage(searchParams, 20, 100);
  const total = records.length;
  return ok(records.slice((page - 1) * pageSize, page * pageSize), pageMeta(page, pageSize, total));
}

/** v1 创建持仓记录 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
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
  const record = createRecord(user.id, input);
  logActivity(user.id, "created", record.name, record.code, {
    market: record.market,
    price: record.price,
    cost: record.cost,
    qty: record.qty
  });
  return ok(record);
}
