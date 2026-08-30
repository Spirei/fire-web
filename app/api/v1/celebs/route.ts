import { getCelebsData } from "@/lib/celebsData";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 名人持仓列表（含持仓明细 / 交易 / 收益概览） */
export async function GET() {
  try {
    const data = await getCelebsData();
    return ok(data);
  } catch {
    return fail(50002, "获取名人持仓失败，请稍后重试", 502);
  }
}
