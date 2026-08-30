import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { deleteRecordsByIds, listRecords, logActivity } from "@/lib/store";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? [...new Set(body.ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))]
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "请选择要删除的记录" }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: "单次最多删除 200 条记录" }, { status: 400 });
  }

  const targets = listRecords(user.id).filter((r) => ids.includes(r.id));
  if (targets.length === 0) {
    return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  }

  const deleted = deleteRecordsByIds(user.id, targets.map((t) => t.id));
  targets.forEach((t) => {
    logActivity(user.id, "deleted", t.name, t.code, {
      market: t.market,
      price: t.price,
      cost: t.cost,
      qty: t.qty
    });
  });

  return NextResponse.json({ ok: true, deleted });
}
