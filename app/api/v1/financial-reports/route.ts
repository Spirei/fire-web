import { fail, ok } from "@/lib/api";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { listFinancialReportFiles, saveFinancialReportFile } from "@/lib/financialReports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return ok(listFinancialReportFiles({ market: params.get("market") || undefined, exchange: params.get("exchange") || undefined, code: params.get("code") || undefined }));
}

export async function POST(request: Request) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401); if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  try {
    const form = await request.formData(); const file = form.get("file");
    if (!(file instanceof File)) return fail(40001, "请选择财报文件", 400);
    const result = await saveFinancialReportFile({ file, market: String(form.get("market") || ""), exchange: String(form.get("exchange") || ""), code: String(form.get("code") || ""), companyName: String(form.get("companyName") || ""), fiscalYear: Number(form.get("fiscalYear")), fiscalPeriod: String(form.get("fiscalPeriod") || ""), reportType: String(form.get("reportType") || ""), userId: user.id });
    return ok(result);
  } catch (error) { return fail(40001, error instanceof Error ? error.message : "财报上传失败", 400); }
}
