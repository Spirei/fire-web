import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { cardLibraryForUser } from "@/lib/cardLibrary";

export const dynamic = "force-dynamic";

/** 卡面库清单 + 当前用户的持有 / 金额 / 标签。
 *  页面首屏已由布局直接注入同一份数据（见 app/[...slug]/layout.tsx），
 *  这个接口留给挂载后的静默刷新，避免跨设备改动看不到。 */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const payload = cardLibraryForUser(user.id);
  if (payload.regions.length === 0) {
    return NextResponse.json(
      {
        ...payload,
        error: "还没有卡面素材：在项目根目录执行 node scripts/fetch-card-assets.mjs 抓取"
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
