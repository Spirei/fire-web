import { assetGrant, assetsResponse } from "./appAssetsApi";
import { getDb } from "./db";
import { fail, ok } from "./api";
import { RecordsError } from "./recordsContract";
import { readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { rateLimit } from "./rateLimit";
import { fetchOverviewQuotes } from "./quotes";
import { assetOrderRows } from "./appAssetOrders";
import { isFundCurrency } from "./funds";
import { tradingSnapshot, previewTrade, submitTrade, amendTrade, observeTrade, validateObservation, cashSnapshot, reconcileCash } from "./appTrading";

type Action = "snapshot" | "preview" | "submit" | "amend" | "observe" | "cash" | "positions" | "summary";
export async function tradingResponse(request: Request, action: Action, params?: Promise<{ orderId: string }>) {
  try {
    const scope = action === "cash" ? request.method === "GET" ? "cash.read" : "portfolio.write"
      : action === "snapshot" ? "orders.read" : action === "positions" ? "positions.read" : action === "summary" ? "assets.read" : "orders.write";
    const first = assetGrant(request, scope), authorize = () => {
      const current = assetGrant(request, scope);
      if (current.id !== first.id || current.user_id !== first.user_id || current.security_stamp !== first.security_stamp) throw new RecordsError("连接已变化", 401);
      return current.user_id;
    };
    const args = params ? await params : undefined;
    authorize();
    const query = new URL(request.url).searchParams;
    if (action === "cash" && request.method === "GET") {
      if ([...query.keys()].some(k => !["limit", "offset", "currency", "snapshotRevision"].includes(k) || query.getAll(k).length !== 1)) throw new RecordsError("资金查询参数无效");
      const limit = query.get("limit") ?? "100", offset = query.get("offset") ?? "0", currency = query.get("currency") ?? undefined, revision = query.get("snapshotRevision") ?? undefined;
      if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 200 || !/^(0|[1-9]\d*)$/.test(offset) || !Number.isSafeInteger(Number(offset)) || currency !== undefined && !isFundCurrency(currency) || revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) throw new RecordsError("资金分页或币种无效");
      return ok(getDb().transaction(() => { authorize(); return cashSnapshot(first.user_id, { limit: Number(limit), offset: Number(offset), currency, snapshotRevision: revision }); })());
    }
    if (query.size) throw new RecordsError("不支持查询参数");
    if (action === "positions" || action === "summary") {
      const response = await assetsResponse(request, "snapshot"); authorize();
      if (response.status !== 200) return response;
      const { data } = await response.json(); authorize();
      return ok({ accountId: data.accountId, snapshotRevision: data.snapshotRevision, asOf: data.asOf, currency: data.currency,
        collectionRevision: data.collectionRevision, ...(action === "positions" ? { items: data.positions } : { summary: data.summary, markets: data.markets }) });
    }
    if (action === "snapshot") return ok(getDb().transaction(() => { authorize(); return tradingSnapshot(first.user_id); })());
    if (!rateLimit(`app-trade:${first.user_id}`, 120, 60_000)) throw new RecordsError("请求过于频繁", 429);
    const body = await readJsonBody(request, 65_536); authorize();
    if (action === "preview") return ok(getDb().transaction(() => { authorize(); return previewTrade(first.user_id, body); })());
    let outcome;
    if (action === "observe") {
      validateObservation(first.user_id, body);
      const row = assetOrderRows(first.user_id).find(row => row.id === args?.orderId);
      if (!row) throw new RecordsError("本人订单不存在", 404);
      const snapshot = await fetchOverviewQuotes([{ id: row.id, market: row.market, code: row.code }], 1_500, { tracked: false }); authorize();
      outcome = observeTrade(first.user_id, row.id, body, snapshot.quotes[row.id], authorize);
    } else if (action === "cash") outcome = reconcileCash(first.user_id, body, authorize);
    else if (action === "amend") outcome = amendTrade(first.user_id, args?.orderId ?? "", body, authorize);
    else outcome = submitTrade(first.user_id, body, authorize);
    return outcome.error ? fail(outcome.error.code, outcome.error.message, outcome.error.status) : ok(outcome.result);
  } catch (error) {
    const status = error instanceof RecordsError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 500;
    return fail(error instanceof RecordsError ? error.code : status * 100 + 1, error instanceof RecordsError ? error.message : status === 413 ? "请求内容超过上限" : "交易未确认，请只读查询回执", status);
  }
}
