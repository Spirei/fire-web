import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { RecordsError } from "./recordsContract";
export function assetGrant(request: Request, requiredScope?: string) {
  try { assertAppOrigin(request); } catch { throw new RecordsError("请求来源不受信任", 403); }
  const token = request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
  const grant = token ? authenticateAppAccess(token, request) : null;
  if (!grant) throw new RecordsError("需要有效的 App 连接", 401);
  if (!grant.scope.split(" ").includes(requiredScope ?? (request.method === "GET" ? "portfolio.read" : "portfolio.write"))) throw new RecordsError("连接缺少明确授权的范围", 403);
  return grant;
}
