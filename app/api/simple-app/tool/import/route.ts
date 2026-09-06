import { NextRequest } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { parseYouzhiyouxing, type XlsxInvest } from "@/lib/simpleLedgerXlsx";

export const runtime = "nodejs";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** POST multipart（字段 file）→ 上传「有知有行」xlsx，返回解析后的投资账户数组 */
export async function POST(request: NextRequest) {
  if (!getAuthUser(request)) return json({ ok: false, error: "未登录" }, 401);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "无效请求" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "缺少文件" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ ok: false, error: "文件不能超过 10MB" }, 413);
  }

  const name = String(file.name || "");
  const lower = name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || (file.type as string).includes("spreadsheetml")) {
    let invest: XlsxInvest[];
    try {
      invest = parseYouzhiyouxing(buffer);
    } catch {
      return json({ ok: false, error: "无法解析该 xlsx 文件" }, 400);
    }
    if (!invest.length) return json({ ok: false, error: "未识别到「投资记账」数据（需包含账户名称 / 记录类型表头）" }, 400);
    return json({ ok: true, format: "youzhiyouxing", invest }, 200);
  }

  return json({ ok: false, error: "仅支持 .xlsx 或 .json（json 请直接在前端导入）" }, 400);
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
