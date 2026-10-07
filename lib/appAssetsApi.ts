import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { getDb } from "./db";
import { findUserById } from "./auth";
import { listRecords } from "./store";
import { getRates } from "./rates";
import { fetchOverviewQuotes } from "./quotes";
import { fail, ok } from "./api";
import { readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { RecordsError } from "./recordsContract";
import { rateLimit } from "./rateLimit";
import { assetOperation, assetValuationBasis, buildAssets, declareInstrument, instrumentRows, instrumentSnapshot, type AssetOptions } from "./appAssets";

import { ASSET_ORDER_FILTERS, assetOrderRows, selectAssetOrders, assetOrdersResult, cancelAssetOrders } from "./appAssetOrders";

function assetGrant(request: Request) {
  try { assertAppOrigin(request); } catch { throw new RecordsError("请求来源不受信任", 403); }
  const token = request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
  const grant = token ? authenticateAppAccess(token, request) : null;
  if (!grant) throw new RecordsError("需要有效的 App 连接", 401);
  if (!grant.scope.split(" ").includes(request.method === "GET" ? "portfolio.read" : "portfolio.write")) throw new RecordsError("连接缺少明确授权的范围", 403);
  return grant;
}
export async function assetsResponse(request: Request, action: "snapshot" | "instrument" | "operation" | "orders" | "cancel_orders", params?: Promise<{ recordId?: string; requestId?: string }>) {
  try {
    const initial = assetGrant(request), authorize = () => {
      const current = assetGrant(request);
      if (current.id !== initial.id || current.user_id !== initial.user_id || current.security_stamp !== initial.security_stamp) throw new RecordsError("连接已变化，请重新读取", 401);
      return current.user_id;
    };
    const args = params ? await params : {};
    authorize();
    if (action === "cancel_orders") {
      if (!rateLimit(`asset-cancel:${initial.user_id}`, 120, 60_000)) throw new RecordsError("提交过于频繁", 429);
      if (new URL(request.url).searchParams.size) throw new RecordsError("不支持查询参数");
      const body = await readJsonBody(request, 65_536);
      const { result, error } = cancelAssetOrders(initial.user_id, body, authorize);
      return error ? fail(error.code, error.message, error.status) : ok(result);
    }
    if (action === "orders") {
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(k => !["scope", "status", "recordId"].includes(k) || query.getAll(k).length !== 1)) throw new RecordsError("查询参数无效");
      const scope = query.get("scope") ?? "today", status = query.get("status") ?? "all", recordId = query.get("recordId");
      if (!["today", "all"].includes(scope) || !(ASSET_ORDER_FILTERS as readonly string[]).includes(status) || recordId !== null && (!recordId || recordId.length > 200)) throw new RecordsError("订单筛选无效");
      const original = assetOrderRows(initial.user_id), now = Date.now();
      const snapshot = await fetchOverviewQuotes(selectAssetOrders(original, scope, status, recordId, now).map(row => ({ id: row.id, market: row.market, code: row.code })), 1_500);
      return getDb().transaction(() => {
        authorize();
        const current = assetOrderRows(initial.user_id), old = new Map(original.map(row => [row.id, row]));
        const cached = new Set(snapshot.cached);
        const quotes = Object.fromEntries(current.filter(row => old.get(row.id)?.revision === row.revision && old.get(row.id)?.market === row.market && old.get(row.id)?.code === row.code && snapshot.quotes[row.id]).map(row => [row.id, { ...snapshot.quotes[row.id], cached: cached.has(row.id) || !!snapshot.quotes[row.id].cached }]));
        return ok(assetOrdersResult(initial.user_id, current, scope, status, recordId, Date.now(), quotes));
      })();
    }
    if (action === "operation") return ok(assetOperation(initial.user_id, args.requestId ?? ""));
    if (action === "instrument") {
      if (request.method === "GET") return ok(instrumentSnapshot(initial.user_id, args.recordId ?? ""));
      if (!rateLimit(`asset-declare:${initial.user_id}`, 120, 60_000)) throw new RecordsError("提交过于频繁", 429);
      const body = await readJsonBody(request, 16_384);
      const { result, error } = declareInstrument(initial.user_id, args.recordId ?? "", body, authorize);
      return error ? fail(error.code, error.message, error.status) : ok(result);
    }
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(k => !["currency", "costMethod", "usPrice"].includes(k)) || [...query.keys()].some(k => query.getAll(k).length !== 1)) throw new RecordsError("查询参数无效");
    const currency = query.get("currency") ?? "USD", costMethod = query.get("costMethod") ?? "diluted", usPrice = query.get("usPrice") ?? "observed";
    if (!/^[A-Z]{3}$/.test(currency) || !["diluted", "average_open"].includes(costMethod) || !["observed", "regular"].includes(usPrice)) throw new RecordsError("资产显示参数无效");
    const options: AssetOptions = { currency, costMethod: costMethod as AssetOptions["costMethod"], usPrice: usPrice as AssetOptions["usPrice"] };
    const rates = { ...await getRates() };
    authorize();
    if (!Number.isFinite(rates[currency]) || rates[currency] <= 0) throw new RecordsError("缺少显示币种汇率");
    const records = listRecords(initial.user_id), declarations = instrumentRows(initial.user_id);
    const declarationByRecord = new Map(declarations.map(d => [d.record_id, d]));
    const items = records.filter(r => {
      return Number(r.qty) > 0 && assetValuationBasis(r, declarationByRecord.get(r.id)) !== "unavailable";
    });
    // Read existing public quote cache/provider only; do not create private subscriptions or settle orders.
    const snapshot = await fetchOverviewQuotes(items, 1_500);
    return getDb().transaction(() => {
      authorize();
      const user = findUserById(initial.user_id);
      if (!user) throw new RecordsError("账号已失效", 401);
      const current = listRecords(initial.user_id);
      const original = new Map(records.map(r => [r.id, `${r.market}:${r.code}:${r.revision}`]));
      const cached = new Set(snapshot.cached);
      const quotes = Object.fromEntries(current.filter(r => original.get(r.id) === `${r.market}:${r.code}:${r.revision}` && snapshot.quotes[r.id]).map(r => [r.id, { ...snapshot.quotes[r.id], cached: cached.has(r.id) || !!snapshot.quotes[r.id].cached }]));
      return ok(buildAssets(initial.user_id, { username: user.username, nickname: user.nickname ?? "", uid: user.uid ?? "", avatar: user.avatar ?? "" }, rates, quotes, options));
    })();
  } catch (error) {
    const status = error instanceof RecordsError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 500;
    return fail(error instanceof RecordsError ? error.code : status * 100 + 1, error instanceof RecordsError ? error.message : status === 413 ? "请求内容超过上限" : "资产读取或提交未确认，请查询回执", status);
  }
}
