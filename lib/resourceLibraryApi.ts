import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { appV2Access, appV2KnownPath } from "./appApiV2Policy";
import { ok, fail } from "./api";
import { readFormBody, readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { rateLimit } from "./rateLimit";
import { resourceLibraryDiscovery, RESOURCE_UPLOAD_LIMIT } from "./resourceLibraryConfig";
import { ResourceError, resourceUsage, resourceFiles, resourceFolders, createResourceFolder, deleteResourceFolder, resourceFile, uploadResource, deleteResource, resourceOperation, downloadResource } from "./resourceLibrary";

// Keep buffered multipart parsing bounded across requests in each server process.
const uploadSlots = globalThis as typeof globalThis & { alcorResourceUploads?: number };
export type ResourceContext = { params: Promise<{ action?: string[] }> };
export async function resourceLibraryResponse(request: Request, context: ResourceContext, version: 1 | 2) {
  try {
    try { assertAppOrigin(request); } catch { throw new ResourceError("请求来源不受信任", 403); }
    const canonical = new URL(request.url).pathname.replace(/^\/api\/v1\//, "/api/v2/");
    const access = appV2Access(canonical, request.method);
    if (!access) throw new ResourceError(appV2KnownPath(canonical) ? "不支持此请求方法" : "接口不存在", appV2KnownPath(canonical) ? 405 : 404);
    const authorize = () => {
      const token = request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) throw new ResourceError("需要有效的 App 连接", 401);
      const grant = authenticateAppAccess(token, request);
      if (!grant) throw new ResourceError("连接已失效，请重新连接", 401);
      if (!grant.scope.split(" ").includes(access)) throw new ResourceError("连接缺少此操作的授权范围", 403);
      return grant.user_id;
    };
    const user = authorize(), action = (await context.params).action || [], key = action.join("/"), q = new URL(request.url).searchParams;
    if (!rateLimit(`resource-library:${user}`, 180, 60_000)) throw new ResourceError("请求过于频繁", 429);
    const result = async (): Promise<Response> => {
      if (request.method === "GET") {
        if (!key) return ok({ ...resourceLibraryDiscovery(version), usage: resourceUsage(user) });
        if (key === "folders") return ok(resourceFolders(user, q));
        if (key === "files") return ok(resourceFiles(user, q, version));
        if (action.length === 2 && action[0] === "files") return ok(resourceFile(user, action[1], version));
        if (action.length === 3 && action[0] === "files" && action[2] === "content") return downloadResource(user, action[1], request.headers.get("range"));
        if (action.length === 2 && ["uploads", "deletions"].includes(action[0])) return ok(resourceOperation(user, action[1], action[0] === "uploads" ? "upload" : "delete", version));
      }
      if (request.method === "POST" && key === "files") {
        if ((uploadSlots.alcorResourceUploads || 0) >= 2) throw new ResourceError("服务器正在接收文件，请稍后再试", 429);
        if (!rateLimit(`resource-library-upload:${user}`, 30, 3600_000)) throw new ResourceError("上传过于频繁", 429);
        uploadSlots.alcorResourceUploads = (uploadSlots.alcorResourceUploads || 0) + 1;
        try {
          let form: FormData;
          try { form = await readFormBody(request, RESOURCE_UPLOAD_LIMIT + 65536); }
          catch (e) { if (e instanceof RequestBodyTooLargeError) throw e; throw new ResourceError("上传格式无效"); }
          if ([...form.keys()].some(k => !["category", "folderId", "file", "requestId", "name"].includes(k) || form.getAll(k).length !== 1)) throw new ResourceError("上传字段无效");
          const file = form.get("file");
          if (!(file instanceof File)) throw new ResourceError("请选择文件");
          // Native multipart headers cannot reliably preserve quotes/literal %22.
          // A UTF-8 text field carries the original name, independent of transport filename.
          const name = form.has("name") ? form.get("name") : file.name;
          if (typeof name !== "string") throw new ResourceError("文件名称无效");
          if (!file.size || file.size > RESOURCE_UPLOAD_LIMIT) throw new ResourceError("文件须为 1 字节至 50 MiB", 413);
          const bytes = Buffer.from(await file.arrayBuffer());
          if (authorize() !== user) throw new ResourceError("连接已失效", 401);
          const response = ok(uploadResource(user, bytes, { category: form.get("category"), name, folderId: form.has("folderId") ? form.get("folderId") : undefined, requestId: form.get("requestId") }, version));
          return new Response(response.body, { status: 201, headers: response.headers });
        } finally { uploadSlots.alcorResourceUploads!--; }
      }
      let body: unknown;
      try { body = await readJsonBody(request, 4096); }
      catch (e) { if (e instanceof RequestBodyTooLargeError) throw e; throw new ResourceError("请求格式无效"); }
      if (authorize() !== user) throw new ResourceError("连接已失效", 401);
      if (request.method === "POST" && key === "folders") {
        const response = ok(createResourceFolder(user, body));
        return new Response(response.body, { status: 201, headers: response.headers });
      }
      if (request.method === "DELETE" && action.length === 2 && action[0] === "folders") return ok(deleteResourceFolder(user, action[1], body));
      if (request.method === "DELETE" && action.length === 2 && action[0] === "files") return ok(deleteResource(user, action[1], body));
      throw new ResourceError("接口不存在", 404);
    };
    // params can be asynchronous; validate again before reading or streaming an owned resource.
    if (authorize() !== user) throw new ResourceError("连接已失效", 401);
    const response = await result();
    response.headers.set("X-Alcor-API-Version", String(version));
    return response;
  } catch (error) {
    const status = error instanceof ResourceError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 500;
    return fail(status * 100 + 1, error instanceof ResourceError ? error.message : status === 413 ? "内容超过上限" : "资源库暂不可用，请查询操作结果", status);
  }
}
