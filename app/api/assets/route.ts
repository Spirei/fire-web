import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { deleteAsset, ensureBrokerAssets, ensureCategoryAssets, ensureIconAssets, ensureMarketAssets, ensureStockAssets, getAssets, getStockIconMap, upsertAsset, type AssetType } from "@/lib/assets";
import { enrichAssetQuotes, enrichStockAssetQuotes } from "@/lib/assetQuotes";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") as AssetType | null;
  if (type === "icon") ensureIconAssets();
  if (type === "market") ensureMarketAssets();
  if (type === "crypto" || type === "metal" || type === "flag") ensureCategoryAssets(type);
  if (type === "stock") ensureStockAssets();
  if (type === "broker") ensureBrokerAssets();
  const market = searchParams.get("market");
  const code = searchParams.get("code");
  const keysParam = searchParams.get("keys");
  if (type === "stock" && (keysParam || (market && code))) {
    const pairs = keysParam
      ? keysParam.split(",").slice(0, 200).flatMap((key) => {
          const separator = key.indexOf(":");
          if (separator <= 0) return [];
          return [{ market: key.slice(0, separator), code: key.slice(separator + 1) }];
        })
      : [{ market: market || "", code: code || "" }];
    const map = getStockIconMap(pairs);
    const assets = Object.entries(map).map(([key, url]) => {
      const separator = key.indexOf(":");
      const itemMarket = key.slice(0, separator);
      const itemCode = key.slice(separator + 1);
      return {
        id: `stock:${itemMarket}:${itemCode}`,
        type: "stock" as const,
        market: itemMarket,
        code: itemCode,
        name: itemCode,
        url,
        urlDark: "",
        marketCap: 0,
        price: null,
        changePct: null,
        source: "auto" as const,
        lastCheckedAt: "",
        board: "",
        updatedAt: ""
      };
    });
    return NextResponse.json({ assets });
  }
  const assets =
    type === "stock" || type === "market" || type === "flag" || type === "crypto" || type === "metal" || type === "broker" || type === "group" || type === "icon"
      ? getAssets(type)
      : getAssets();
  // crypto / metal 行合并实时行情（CoinGecko + 贵金属），缺失字段补上市值 / 现价 / 涨跌幅
  return NextResponse.json({ assets: await enrichStockAssetQuotes(enrichAssetQuotes(assets)) });
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !["stock", "market", "flag", "crypto", "metal", "broker", "group", "icon"].includes(body.type)) {
    return NextResponse.json({ error: "type 必须为 stock / market / flag / broker / crypto / metal / group / icon" }, { status: 400 });
  }
  const type = body.type as AssetType;
  const market = type === "broker" ? "GROUP" : String(body.market ?? "").trim();
  if ((type === "stock" || type === "market") && !market) {
    return NextResponse.json({ error: "缺少市场标识" }, { status: 400 });
  }
  if ((type === "flag" || type === "crypto" || type === "metal" || type === "broker" || type === "icon") && !String(body.code ?? "").trim()) {
    return NextResponse.json({ error: "资产图标需要代码，如 BTC / GOLD / 分组 ID" }, { status: 400 });
  }
  const url = String(body.url ?? "").trim();
  if (!url && type === "market") return NextResponse.json({ error: "缺少图片地址" }, { status: 400 });
  if (type === "stock" && !String(body.code ?? "").trim()) {
    return NextResponse.json({ error: "股票图标需要股票代码" }, { status: 400 });
  }
  const asset = upsertAsset({
    type,
    market,
    code: String(body.code ?? ""),
    name: String(body.name ?? ""),
    url,
    urlDark: body.urlDark === undefined ? undefined : String(body.urlDark ?? ""),
    id: body.id ? String(body.id) : undefined
  });
  // 主动上传 / 改名（附件管理 / 素材库编辑）：强制更新 url 与 name，不受自动同步的 manual 保护影响
  if (body.id) {
    getDb()
      .prepare(
        "UPDATE assets SET url = CASE WHEN ? <> '' THEN ? ELSE url END, url_dark = CASE WHEN ? IS NOT NULL THEN ? ELSE url_dark END, name = CASE WHEN ? <> '' THEN ? ELSE name END, updated_at = ? WHERE id = ?"
      )
      .run(url, url, body.urlDark === undefined ? null : String(body.urlDark ?? ""), body.urlDark === undefined ? null : String(body.urlDark ?? ""), String(body.name ?? "").trim(), String(body.name ?? "").trim(), new Date().toISOString(), String(body.id));
  }
  return NextResponse.json({ asset });
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    const body = await request.json().catch(() => null);
    if (!body?.id) return NextResponse.json({ error: "缺少素材 id" }, { status: 400 });
    deleteAsset(String(body.id));
    return NextResponse.json({ ok: true });
  }
  deleteAsset(id);
  return NextResponse.json({ ok: true });
}
