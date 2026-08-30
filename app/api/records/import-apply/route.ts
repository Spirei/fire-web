import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { applyImport, type ImportRow } from "@/lib/importSnapshot";
import { listWatchGroups } from "@/lib/watchGroupsStore";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const groupId = typeof body?.groupId === "string" ? body.groupId.trim().slice(0, 100) : "";
  if (groupId) {
    const group = listWatchGroups(user.id).find((item) => item.id === groupId);
    if (!group || group.kind !== "custom") return NextResponse.json({ error: "分组不存在或不可用于导入" }, { status: 400 });
  }
  const rawRows: unknown[] = Array.isArray(body?.rows) ? body.rows : [];
  if (rawRows.length === 0) return NextResponse.json({ error: "没有可导入的记录" }, { status: 400 });
  if (rawRows.length > 100) return NextResponse.json({ error: "单次最多导入 100 条" }, { status: 400 });

  const rows: ImportRow[] = rawRows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r: Record<string, unknown>): ImportRow => ({
      name: typeof r.name === "string" ? r.name.trim().slice(0, 100) : "",
      code: typeof r.code === "string" ? r.code.trim().slice(0, 40) : "",
      market: typeof r.market === "string" ? r.market.trim().toUpperCase().slice(0, 10) : "",
      qty: typeof r.qty === "number" && Number.isFinite(r.qty) ? r.qty : null,
      price: typeof r.price === "number" && Number.isFinite(r.price) ? r.price : null,
      cost: typeof r.cost === "number" && Number.isFinite(r.cost) ? r.cost : null,
      changePct: null,
      status: "new",
      matched: false
    }))
    .filter((r: ImportRow) => r.name || r.code);

  if (rows.length === 0) return NextResponse.json({ error: "没有有效的导入记录" }, { status: 400 });

  const result = applyImport(user.id, rows, groupId || undefined);
  return NextResponse.json({
    added: result.added,
    updated: result.updated,
    skipped: result.skipped,
    total: rows.length
  });
}
