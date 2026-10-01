import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { parseApiDocsVersion } from "@/lib/apiDocsVersion";
import { API_DOCS_MAX_BYTES, readApiDocument, saveApiDocument } from "@/lib/apiDocs";
export const dynamic = "force-dynamic";
function versionFor(request?: Request) {
  if (!request) return 1 as const;
  const values = new URL(request.url).searchParams.getAll("version");
  return values.length > 1 ? null : parseApiDocsVersion(values[0]);
}
/** Public reference; the version selects one of two fixed files. */
export async function GET(request?: Request) {
  const version = versionFor(request);
  if (!version) return fail(40001, "不支持的文档版本", 400);
  try { return ok(readApiDocument(version)); }
  catch { return fail(50001, "读取文档失败", 500); }
}
export async function POST(request: Request) {
  const version = versionFor(request);
  if (!version) return fail(40001, "不支持的文档版本", 400);
  const initial = getAuthUser(request);
  if (!initial) return fail(40101, "未登录", 401);
  if (!isAdmin(initial)) return fail(40301, "需要管理员权限", 403);
  const body = await readJsonBody(request, API_DOCS_MAX_BYTES * 6 + 1024).catch(() => null);
  if (!body || typeof body.content !== "string" || Object.keys(body).some(key => !["content", "expectedRevision"].includes(key)) ||
      (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision)))) return fail(40001, "文档参数无效", 400);
  if (Buffer.byteLength(body.content, "utf8") > API_DOCS_MAX_BYTES) return fail(40001, "文档内容过大", 400);
  const current = getAuthUser(request);
  if (!current || current.id !== initial.id) return fail(40101, "登录已失效", 401);
  if (!isAdmin(current)) return fail(40301, "需要管理员权限", 403);
  try {
    const result = saveApiDocument(version, body.content, body.expectedRevision);
    return result ? ok(result) : fail(40901, "文档已被更新，请重新读取后再保存", 409);
  } catch { return fail(50001, "保存文档失败", 500); }
}
