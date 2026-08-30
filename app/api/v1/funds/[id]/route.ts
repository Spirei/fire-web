import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { deleteFundTransaction, fundBalances } from "@/lib/funds";
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request); if (!user) return fail(40101, "未登录", 401);
  const { id } = await params;
  if (!deleteFundTransaction(user.id, id)) return fail(40401, "资金记录不存在", 404);
  return ok({ deleted: true, balances: fundBalances(user.id) });
}
