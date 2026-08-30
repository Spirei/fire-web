import { getCelebsData } from "@/lib/celebsData";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 单个名人持仓详情 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const data = await getCelebsData();
    const celeb = (data.celebs ?? []).find((c) => c.id === id);
    if (!celeb) return fail(40401, "名人不存在", 404);
    return ok({
      celeb,
      detail: data.detail?.[id] ?? null,
      source: data.source ?? "sample"
    });
  } catch {
    return fail(50002, "获取名人持仓失败", 502);
  }
}
