import { fail, ok } from "@/lib/api";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { deleteFinancialReportFile } from "@/lib/financialReports";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401); if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const { id } = await context.params;
  if (!deleteFinancialReportFile(id)) return fail(40401, "财报文件不存在", 404);
  return ok({ deleted: true });
}
