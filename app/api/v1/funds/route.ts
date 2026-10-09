import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { FUND_CURRENCIES, isFundCurrency, type FundCurrency } from "@/lib/fundCurrencies";
import { fundState } from "@/lib/fundState";
import { setCashBalance } from "@/lib/cashBalance";
import { countFundTransactions, createFundTransaction, ensureOrderCashTransactions, listFundTransactions, type FundType } from "@/lib/funds";

const currencies = new Set<string>(FUND_CURRENCIES);
const types = new Set(["opening", "deposit", "withdrawal", "adjustment"]);

export async function GET(request: Request) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401);
  const params = new URL(request.url).searchParams;
  const recordsOnly = params.get("recordsOnly") === "1";
  if (!recordsOnly) ensureOrderCashTransactions(user.id);
  const rawLimit = Number(params.get("limit"));
  const rawOffset = Number(params.get("offset"));
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit || 40))) : 40;
  const offset = Number.isFinite(rawOffset) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(rawOffset))) : 0;
  const requestedCurrency = String(params.get("currency") || "").toUpperCase();
  const currency = currencies.has(requestedCurrency) ? requestedCurrency as FundCurrency : undefined;
  const query = String(params.get("q") || "").trim().slice(0, 60);
  const total = countFundTransactions(user.id, currency, query);
  const records = { transactions: listFundTransactions(user.id, limit, offset, currency, query), pagination: { limit, offset, total, hasMore: offset + limit < total } };
  if (recordsOnly) return ok(records);
  return ok({ ...fundState(user.id), ...records });
}
export async function POST(request: Request) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401);
  const body = await readJsonBody(request).catch(() => null); if (!body) return fail(40001, "无效请求", 400);
  if (body.action === "set_balance") {
    const currentUser = getAuthUser(request);
    if (!currentUser || currentUser.id !== user.id) return fail(40101, "未登录", 401);
    const result = setCashBalance(user.id, body.currency, body.targetBalance, body.expectedBalance);
    if ("error" in result) return fail(result.status === 409 ? 40901 : 40001, result.error, result.status);
    return ok({ transaction: result.transaction, ...fundState(user.id) });
  }
  const rawCurrency = String(body.currency || "").toUpperCase();
  const type = String(body.type || "") as FundType;
  const amount = Number(body.amount); const direction = Number(body.direction);
  const note = String(body.note || "").trim();
  if (!isFundCurrency(rawCurrency) || !types.has(type) || !Number.isFinite(amount) || amount <= 0 || amount > 1e12 || (direction !== 1 && direction !== -1) || note.length > 200) return fail(40001, "资金记录参数无效", 400);
  const currency: FundCurrency = rawCurrency;
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 86400000) return fail(40001, "资金日期无效", 400);
  const transaction = createFundTransaction({ userId: user.id, currency, type, amount, direction: direction as 1 | -1, note, occurredAt: occurredAt.toISOString() });
  return ok({ transaction, ...fundState(user.id) });
}
