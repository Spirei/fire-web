import { NextResponse } from "next/server";
import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { getAuthUser } from "./auth";
import { parsePage } from "./api";
import { readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { rateLimit } from "./rateLimit";
import { mutateRecords, readRecordOperation, recordSnapshot, recordsSnapshot, RecordsError } from "./recordsContract";

/** Missing native scopes are 403 in both versions; Cookie never fills them. */
function authorizeRecords(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer fat_")) {
    try { assertAppOrigin(request); } catch { throw new RecordsError("请求来源不受信任", 403); }
    if (!/^\/api\/v[12]\/records(?:\/|$)/.test(new URL(request.url).pathname)) throw new RecordsError("接口不接受 App 连接", 401);
    const token = authorization.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
    const grant = token ? authenticateAppAccess(token, request) : null;
    if (!grant) throw new RecordsError("连接已失效", 401);
    const scope = request.method === "GET" ? "portfolio.read" : "portfolio.write";
    if (!grant.scope.split(" ").includes(scope)) throw new RecordsError("连接缺少此操作的授权范围", 403);
    return grant.user_id;
  }
  const user = getAuthUser(request);
  if (!user) throw new RecordsError("未登录", 401);
  return user.id;
}
export async function recordsResponse(request: Request, action: "list" | "record" | "operation", params?: Promise<{ id?: string; requestId?: string }>, web = false) {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, private" } });
  try {
    const userId = authorizeRecords(request), args = params ? await params : {};
    const authorize = () => authorizeRecords(request);
    if (authorize() !== userId) throw new RecordsError("连接已失效", 401);
    if (request.method === "GET") {
      if (action === "operation") return respond({ code: 0, message: "ok", data: readRecordOperation(userId, args.requestId ?? "") });
      if (action === "record") {
        const { record, collectionRevision } = recordSnapshot(userId, args.id ?? "");
        return respond({ code: 0, message: "ok", data: record, meta: { collectionRevision } });
      }
      const q = new URL(request.url).searchParams;
      const snapshot = recordsSnapshot(userId, q.get("collectionRevision"));
      if (web) {
        const response = respond(snapshot.records);
        response.headers.set("X-Alcor-Account-Id", userId);
        response.headers.set("X-Alcor-Records-Revision", String(snapshot.collectionRevision));
        return response;
      }
      const market = (q.get("market") || "").toUpperCase(), group = (q.get("group") || "").trim();
      const filtered = snapshot.records.filter(r => (!market || r.market === market) && (!group || r.group === group));
      const { page, pageSize } = parsePage(q, 20, 100);
      return respond({ code: 0, message: "ok", data: filtered.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: filtered.length, collectionRevision: snapshot.collectionRevision } });
    }
    if (!rateLimit(`records-write:${userId}`, 120, 60_000)) throw new RecordsError("提交过于频繁", 429);
    // A bodyless DELETE is the existing contract; malformed supplied JSON must not become a legacy delete.
    const body = request.method === "DELETE" && request.body === null ? {} : await readJsonBody(request, 16384);
    const kind = request.method === "POST" ? "create" : request.method === "PUT" ? "update" : "delete";
    const { operation: op, error, tracked } = mutateRecords(userId, kind, args.id ?? "", body, authorize, web);
    const meta = tracked ? { requestId: op.requestId, kind: op.kind, recordId: op.recordId, revision: op.revision, collectionRevision: op.collectionRevision } : undefined;
    if (error) return respond(web ? { error: error.message, code: error.code } : { code: error.code, message: error.message, ...(meta ? { meta } : {}) }, error.status);
    const data = kind === "delete" ? (web ? { ok: true } : tracked ? { deleted: true, id: op.recordId, revision: op.revision } : { deleted: true }) : op.record;
    return respond(web ? data : { code: 0, message: "ok", data, ...(meta ? { meta } : {}) }, web && kind === "create" ? 201 : 200);
  } catch (error) {
    const status = error instanceof RecordsError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 500;
    const code = error instanceof RecordsError ? error.code : status * 100 + 1;
    const message = error instanceof RecordsError ? error.message : status === 413 ? "请求内容超过上限" : "提交未确认，请查询操作结果";
    return respond(web ? { error: message, code } : { code, message }, status);
  }
}
