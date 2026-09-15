import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getCelebsData, patchCelebCache, sortCelebCache } from "@/lib/celebsData";
import { createCeleb, deleteCeleb, reorderCelebs, updateCeleb, type CelebInput } from "@/lib/celebsStore";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getCelebsData();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (err) {
    return NextResponse.json(
      { celebs: [], source: "sample", error: "获取名人持仓失败，请稍后重试" },
      { status: 502 }
    );
  }
}

function requireAdmin(request: Request) {
  const user = getAuthUser(request);
  if (!user) return { error: NextResponse.json({ error: "未登录" }, { status: 401 }) };
  if (!isAdmin(user)) return { error: NextResponse.json({ error: "需要管理员权限" }, { status: 403 }) };
  return { user };
}

function cleanId(raw: unknown): string {
  const id = String(raw ?? "").trim().toLowerCase();
  return id.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "";
}

function toCelebInput(body: Record<string, unknown>): CelebInput {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  return {
    id: cleanId(body.id),
    // 名称缺失时返回 undefined（部分更新如启用滑块会不带 name），保留数据库原值；
    // 创建时（POST）由下方校验强制要求
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 50) : undefined,
    title: str(body.title)?.slice(0, 100),
    avatar: str(body.avatar),
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    sourceKind:
      body.sourceKind === "13f" || body.sourceKind === "form4"
        ? (body.sourceKind as CelebInput["sourceKind"])
        : body.sourceKind === "none"
          ? "none"
          : undefined,
    cik: str(body.cik)?.slice(0, 20),
    entity: str(body.entity)?.slice(0, 100),
    sourceLabel: str(body.sourceLabel)?.slice(0, 100),
    holdings: Array.isArray(body.holdings) ? (body.holdings as CelebInput["holdings"]) : undefined,
    trades: Array.isArray(body.trades) ? (body.trades as CelebInput["trades"]) : undefined,
    returns: (body.returns as CelebInput["returns"]) ?? undefined,
    stockIcons: body.stockIcons && typeof body.stockIcons === "object" ? (body.stockIcons as Record<string, string>) : undefined,
    refreshHours: typeof body.refreshHours === "number" && Number.isFinite(body.refreshHours) ? Math.max(0, Math.min(body.refreshHours, 8760)) : undefined
  };
}

export async function POST(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  const input = toCelebInput(body as Record<string, unknown>);
  if (!input.id || !input.name) return NextResponse.json({ error: "需要 id 和名称（id 用于唯一标识，如 bill-gates）" }, { status: 400 });
  // CIK 必须为 10 位数字，防止注入 SEC 查询路径（仅管理端可设置）
  if (input.cik && !/^\d{10}$/.test(input.cik)) {
    return NextResponse.json({ error: "CIK 需为 10 位数字" }, { status: 400 });
  }
  try {
    const celeb = createCeleb(input);
    patchCelebCache(celeb.id);
    return NextResponse.json({ celeb }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "创建失败（id 可能已存在）" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  const raw = body as Record<string, unknown>;
  // 排序：{ reorder: [id1, id2, ...] }
  if (Array.isArray(raw.reorder)) {
    reorderCelebs(raw.reorder.map((x) => String(x)));
    sortCelebCache();
    return NextResponse.json({ ok: true });
  }
  const id = cleanId(raw.id);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const input = toCelebInput(raw);
  if (input.cik && !/^\d{10}$/.test(input.cik)) {
    return NextResponse.json({ error: "CIK 需为 10 位数字" }, { status: 400 });
  }
  const celeb = updateCeleb(id, input);
  if (!celeb) return NextResponse.json({ error: "名人不存在" }, { status: 404 });
  patchCelebCache(id);
  return NextResponse.json({ celeb });
}

export async function DELETE(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;
  const { searchParams } = new URL(request.url);
  const id = cleanId(searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const ok = deleteCeleb(id);
  if (!ok) return NextResponse.json({ error: "名人不存在" }, { status: 404 });
  patchCelebCache(id);
  return NextResponse.json({ ok: true });
}
