import { getAuthUser } from "./auth";
import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { getDb } from "./db";
import { getRates } from "./rates";
import { listRecords } from "./store";
import { fetchOverviewQuotes } from "./quotes";
import { trackQuoteRequest } from "./quoteSubscriptionRequests";
import { readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { fail, ok } from "./api";
import { RecordsError } from "./recordsContract";
import { rateLimit } from "./rateLimit";
import { allocationSnapshotRevision, buildAssetAllocation } from "./assetAllocation";
import { assignAllocationBroker, deleteAllocationAccount, parseAllocationInput, saveAllocationAccount } from "./assetAllocationStore";

export async function assetAllocationResponse(request: Request, appOnly = false) {
  try {
    if (appOnly && !/^Bearer fat_[A-Za-z0-9_-]{43}$/.test(request.headers.get("authorization") || "")) throw new RecordsError("需要有效的 App 连接", 401);
    const token = request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
    if (token) {
      try { assertAppOrigin(request); } catch { throw new RecordsError("请求来源不受信任", 403); }
      const grant = authenticateAppAccess(token, request);
      if (!grant) throw new RecordsError("连接已失效", 401);
      if (!grant.scope.split(" ").includes(request.method === "GET" ? "portfolio.read" : "portfolio.write")) throw new RecordsError("连接缺少授权范围", 403);
    }
    const initial = getAuthUser(request); if (!initial) throw new RecordsError("未登录或连接已失效", 401);
    const expectedOwner = request.headers.get("x-allocation-user");
    if (expectedOwner !== null && expectedOwner !== initial.id) throw new RecordsError("当前账号已切换，请刷新后重试", 409, 40902);
    const authorize = () => { const current = getAuthUser(request); if (!current || current.id !== initial.id) throw new RecordsError("账号或连接已变化，请重新读取", 401); };
    const assertReadActive = () => { authorize(); if (request.signal.aborted) throw new RecordsError("读取已取消", 499, 49901); };
    if (request.method !== "GET") {
      if (!rateLimit(`allocation:${initial.id}`, 60, 60_000)) throw new RecordsError("操作过于频繁", 429);
      const raw = await readJsonBody(request, 16_384).catch(error => { if (error instanceof RequestBodyTooLargeError) throw error; throw new RecordsError("账户参数无效"); });
      return getDb().transaction(() => {
        authorize();
        if (new URL(request.url).pathname.endsWith("/assign")) {
          const snapshot = buildAssetAllocation(initial.id, { USD: 1 }, {}, "USD", true);
          const recordIds = Array.isArray(raw?.records) ? new Set(raw.records.map((r: { id?: unknown } | null) => r?.id)) : new Set();
          const affected = new Set(snapshot.positions.filter(p => recordIds.has(p.id)).flatMap(p => [p.accountId, `broker:${raw?.brokerId}:${p.currency}`]));
          if (snapshot.accounts.some(a => affected.has(a.id) && a.reconciled)) throw new RecordsError("请先恢复相关券商的自动关联，再分配持仓", 409, 40902);
          return ok(assignAllocationBroker(initial.id, raw));
        }
        if (request.method === "DELETE") {
          const b = raw as { id?: unknown; revision?: unknown };
          if (!b || typeof b.id !== "string" || Object.keys(b).some(k => !["id", "revision"].includes(k)) || !Number.isSafeInteger(b.revision) || Number(b.revision) < 1) throw new RecordsError("账户版本无效");
          const source = buildAssetAllocation(initial.id, { USD: 1 }, {}, "USD", true).accounts.find(a => a.id === b.id && a.kind !== "manual");
          deleteAllocationAccount(initial.id, b.id, Number(b.revision), !!source); return ok({ id: b.id, restored: !b.id.startsWith("manual:") });
        }
        const input = parseAllocationInput(raw);
        if (request.method === "PUT" && !input.id || request.method === "POST" && input.id) throw new RecordsError("账户标识无效");
        if (request.method === "POST" && !input.requestId || request.method === "PUT" && input.requestId) throw new RecordsError("新增账户须提供固定的requestId");
        const snapshot = buildAssetAllocation(initial.id, { USD: 1 }, {}, "USD", true);
        const source = snapshot.accounts.find(a => a.id === input.id && a.kind !== "manual");
        if (source && (source.currency !== input.currency || source.category !== input.category)) throw new RecordsError("关联账户的币种和类别不可更改");
        return ok(saveAllocationAccount(initial.id, input, new Set(snapshot.accounts.filter(a => a.kind !== "manual").map(a => a.id))));
      })();
    }
    // 读取会触发上游行情拉取，与写操作一样按账号限流。
    if (!rateLimit(`allocation-read:${initial.id}`, 120, 60_000)) throw new RecordsError("读取过于频繁", 429);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(k => k !== "currency") || query.getAll("currency").length > 1) throw new RecordsError("查询参数无效");
    assertReadActive();
    const currency = query.get("currency") || "USD", rates = { ...await getRates() }; assertReadActive();
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(rates[currency]) || rates[currency] <= 0) throw new RecordsError("缺少显示币种汇率");
    const original = listRecords(initial.id), items = original.filter(r => Number(r.qty) > 0);
    const tracked = await trackQuoteRequest(request, items); assertReadActive();
    const snapshot = await fetchOverviewQuotes(items, 1_500, { tracked });
    return getDb().transaction(() => {
      assertReadActive(); const active = listRecords(initial.id).filter(r => Number(r.qty) > 0), before = new Map(original.map(r => [r.id, r]));
      const quotes = Object.fromEntries(active.filter(r => { const old = before.get(r.id); return old?.revision === r.revision && old?.market === r.market && old?.code === r.code && snapshot.quotes[r.id]; }).map(r => [r.id, snapshot.quotes[r.id]]));
      const data = { ...buildAssetAllocation(initial.id, rates, quotes, currency), quoteStatus: { pending: snapshot.pending, cached: snapshot.cached.filter(id => quotes[id]), missing: active.filter(r => !quotes[r.id]).map(r => r.id) } };
      data.snapshotRevision = allocationSnapshotRevision(data);
      const tag = `W/"${data.snapshotRevision}"`, headers = { "Cache-Control": "no-store, private", ETag: tag,
        Vary: "Authorization, Cookie, X-Allocation-User", "X-Allocation-Observed-At": data.observedAt };
      // The timestamp can differ: this is a weak semantic validator, never a write precondition.
      const condition = request.headers.get("if-none-match");
      const matches = condition?.trim() === "*" || condition?.split(",").some(value => value.trim().replace(/^W\//, "") === tag.slice(2));
      if (matches) return new Response(null, { status: 304, headers });
      const response = ok(data); for (const [name, value] of Object.entries(headers)) response.headers.set(name, value); return response;
    })();
  } catch (error) {
    if (error instanceof RecordsError) return fail(error.code, error.message, error.status);
    if (error instanceof RequestBodyTooLargeError) return fail(41301, "账户参数过大", 413);
    return fail(50001, "资产配置暂时无法读取，请稍后重试", 500);
  }
}
