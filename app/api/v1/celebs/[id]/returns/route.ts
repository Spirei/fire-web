import { getReturnsDaily } from "@/lib/celebsData";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 名人收益分析日线（近 5 年，每天一点 + 对比指数） */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return ok(getReturnsDaily(id));
  } catch {
    return fail(50001, "获取收益数据失败", 500);
  }
}
