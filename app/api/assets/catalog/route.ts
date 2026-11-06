import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { readJsonBody } from "@/lib/requestBody";
import { CATALOG_TYPES, changeCatalog, readCatalog } from "@/lib/assetCatalog";
import {
  ensureMarketAssets,
  ensureStockAssets,
  ensureCategoryAssets,
  ensureBrokerAssets,
  ensureIconAssets,
} from "@/lib/assets";
import { ensureCardAssets } from "@/lib/cardLibrary";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user))
    return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const p = new URL(request.url).searchParams,
    type = p.get("type") || "market";
  if (!CATALOG_TYPES.includes(type as (typeof CATALOG_TYPES)[number]))
    return NextResponse.json({ error: "分类无效" }, { status: 400 });
  if (type === "market") ensureMarketAssets();
  if (type === "stock") ensureStockAssets();
  if (type === "broker") ensureBrokerAssets();
  if (type === "card") ensureCardAssets();
  if (type === "icon") ensureIconAssets();
  if (type === "crypto" || type === "metal" || type === "flag")
    ensureCategoryAssets(type);
  return NextResponse.json(
    readCatalog(
      type as (typeof CATALOG_TYPES)[number],
      p.get("market") || "ALL",
      p.get("q") || "",
      Number(p.get("page") || 1),
      p.get("removed") === "1",
    ),
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user) || !isTrustedMutationRequest(request))
    return NextResponse.json({ error: "无权操作" }, { status: 403 });
  const body = await readJsonBody(request).catch(() => null);
  if (
    !body ||
    typeof body.revision !== "string" ||
    typeof body.action !== "string" ||
    !Array.isArray(body.ids) ||
    body.ids.length > 100 ||
    body.ids.some((id: unknown) => typeof id !== "string" || id.length > 160) ||
    new Set(body.ids).size !== body.ids.length
  )
    return NextResponse.json({ error: "请求无效" }, { status: 400 });
  try {
    const current = getAuthUser(request);
    if (!current || current.id !== user.id || !isAdmin(current))
      return NextResponse.json({ error: "登录已变化" }, { status: 401 });
    return NextResponse.json(changeCatalog(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "操作失败" },
      { status: 409 },
    );
  }
}
