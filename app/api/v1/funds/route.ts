import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { createFundTransaction, fundBalances, listFundTransactions, syncOrderCashTransactions, type FundCurrency, type FundType } from "@/lib/funds";

const currencies = new Set(["USD", "EUR", "HKD", "CNY", "JPY", "KRW", "SGD"]);
const types = new Set(["opening", "deposit", "withdrawal", "adjustment"]);
export async function GET(request: Request) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401);
  const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 100));
  syncOrderCashTransactions(user.id);
  return ok({ balances: fundBalances(user.id), transactions: listFundTransactions(user.id, limit) });
}
export async function POST(request: Request) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401);
  const body = await request.json().catch(() => null); if (!body) return fail(40001, "无效请求", 400);
  const currency = String(body.currency || "") as FundCurrency;
  const type = String(body.type || "") as FundType;
  const amount = Number(body.amount); const direction = Number(body.direction);
  const note = String(body.note || "").trim();
  if (!currencies.has(currency) || !types.has(type) || !Number.isFinite(amount) || amount <= 0 || amount > 1e12 || (direction !== 1 && direction !== -1) || note.length > 200) return fail(40001, "资金记录参数无效", 400);
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 86400000) return fail(40001, "资金日期无效", 400);
  const transaction = createFundTransaction({ userId: user.id, currency, type, amount, direction: direction as 1 | -1, note, occurredAt: occurredAt.toISOString() });
  return ok({ transaction, balances: fundBalances(user.id) });
}
