import { GET as getCompanyProfile } from "@/app/api/company-profile/route";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 公司简况（Web / iOS 共用） */
export async function GET(request: Request) {
  const response = await getCompanyProfile(request);
  const body = await response.json().catch(() => null);
  if (response.ok) return ok(body);
  if (response.status === 400) return fail(40001, body?.error || "参数不合法", 400);
  if (response.status === 404) return fail(40401, body?.error || "未找到公司档案", 404);
  if (response.status === 429) return fail(42901, body?.error || "请求过于频繁", 429);
  return fail(50002, body?.error || "公司资料获取失败", 502);
}
