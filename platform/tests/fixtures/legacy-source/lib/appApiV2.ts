import { appV2Access, appV2KnownPath } from "./appApiV2Policy";
import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { fail } from "./api";

/** Runs the same business service with a strict App-only authentication boundary. */
export async function appV2Response(request: Request, operation: () => Response | Promise<Response>) {
  try {
    try { assertAppOrigin(request); } catch { return fail(40301,"请求来源不受信任",403); }
    const path=new URL(request.url).pathname, access=appV2Access(path,request.method);
    if (!access) return fail(appV2KnownPath(path)?40501:40401,appV2KnownPath(path)?"不支持此请求方法":"接口不存在",appV2KnownPath(path)?405:404);
    if (access !== "credential") {
      const authorization=request.headers.get("authorization");
      const token=authorization?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
      if (access !== "public" || authorization !== null) {
        if (!token) return fail(40101,"需要有效的 App 连接",401);
        const grant=authenticateAppAccess(token,request);
        if (!grant) return fail(40102,"连接已失效，请重新连接",401);
        if (access !== "public" && !grant.scope.split(" ").includes(access)) return fail(40301,"连接缺少此操作的授权范围",403);
      }
    }
    const response=await operation();
    response.headers.set("X-Alcor-API-Version","2");
    return response;
  } catch { return fail(50001,"请求处理失败，请稍后重试",500); }
}
