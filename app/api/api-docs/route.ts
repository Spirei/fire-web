import { readJsonBody } from "@/lib/requestBody";
import fs from "fs";
import path from "path";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const DOC_FILE = path.join(process.cwd(), "docs", "api-spec.md");
const MAX_BYTES = 512 * 1024;

/** 读取 API 规范文档（无需登录，供 /api-docs 页面渲染） */
export async function GET() {
  try {
    const content = fs.readFileSync(DOC_FILE, "utf8");
    return ok({ content, path: "docs/api-spec.md" });
  } catch {
    return fail(50001, "读取文档失败", 500);
  }
}

/** 保存 API 规范文档（仅管理员；固定写 docs/api-spec.md，不接受任意路径） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body.content !== "string") return fail(40001, "缺少文档内容", 400);
  if (body.content.length > MAX_BYTES) return fail(40001, "文档内容过大", 400);
  try {
    fs.mkdirSync(path.dirname(DOC_FILE), { recursive: true });
    fs.writeFileSync(DOC_FILE, body.content, "utf8");
    return ok({ saved: true, bytes: Buffer.byteLength(body.content, "utf8") });
  } catch {
    return fail(50001, "保存文档失败", 500);
  }
}
