import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { upsertAsset } from "@/lib/assets";
import { resolveIcon, sanitizeName } from "@/lib/stockSync";
import { isSafeSvg, sniffImageExt } from "@/lib/imageSecurity";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MAX_ICON_BYTES = 2 * 1024 * 1024;

function trustedIconUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const trusted = host === "coingecko.com" || host.endsWith(".coingecko.com") || host === "companiesmarketcap.com" || host.endsWith(".companiesmarketcap.com");
    return url.protocol === "https:" && trusted ? url : null;
  } catch {
    return null;
  }
}

async function fetchTrustedIcon(raw: string): Promise<Response | null> {
  let url = trustedIconUrl(raw);
  if (!url) return null;
  for (let redirects = 0; redirects <= 2; redirects++) {
    const res: Response = await fetch(url.toString(), {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    if (res.status >= 300 && res.status < 400) {
      const location: string | null = res.headers.get("location");
      const nextUrl: URL | null = location ? trustedIconUrl(new URL(location, url).toString()) : null;
      url = nextUrl;
      if (!url) return null;
      continue;
    }
    return res;
  }
  return null;
}

/** 下载外部图标到本地素材库（crypto / metal），按「名称+代码」命名 */
async function downloadRemoteIcon(iconUrl: string, folder: "crypto" | "metal", code: string, name: string): Promise<string | null> {
  try {
    const res = await fetchTrustedIcon(iconUrl);
    if (!res?.ok) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_ICON_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
    const ext = sniffImageExt(buf);
    if (!ext || (ext === "svg" && !isSafeSvg(buf))) return null;
    const dir = path.join(process.cwd(), "public", "uploads", "asset", folder);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${sanitizeName(name)}${code.toUpperCase()}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return `/uploads/asset/${folder}/${encodeURIComponent(filename)}`;
  } catch {
    return null;
  }
}

/**
 * 素材库「搜索即添加」：按行情源匹配结果添加股票到素材库
 * body: { type?: "stock"|"crypto"|"metal", market, code, name, iconUrl? }
 * 自动尽力下载本地图标（股票走微牛/parqet，crypto/metal 走外部图标 URL 本地化；
 * 失败时 url 留空、前端首字母兜底，后续可手动上传）。
 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!rateLimit(`assets-add:${clientIp(request)}`, 30, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  const type = String(body.type ?? "stock").trim();
  const market = String(body.market ?? "").trim().toUpperCase();
  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  const iconUrl = String(body.iconUrl ?? "").trim();
  if (!["stock", "crypto", "metal"].includes(type)) {
    return NextResponse.json({ error: "type 必须为 stock / crypto / metal" }, { status: 400 });
  }
  if (type === "stock" && !["US", "HK", "CN"].includes(market)) {
    return NextResponse.json({ error: "股票搜索添加仅支持美股 / 港股 / A股" }, { status: 400 });
  }
  if (!code || !name) {
    return NextResponse.json({ error: "缺少股票代码或名称" }, { status: 400 });
  }

  try {
    let url: string | null = "";
    if (type === "stock") {
      // 图标尽力下载（复用同步/回填的微牛 + parqet 解析逻辑）；微牛限流时重试较久，
      // 用 7 秒超时保护：超时则本次留空、添加立即完成，图标后续可手动上传或由回填脚本补齐
      url = await Promise.race([
        resolveIcon(market as "US" | "HK" | "CN", code, name).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 7000))
      ]);
    } else if (iconUrl) {
      url = await downloadRemoteIcon(iconUrl, type as "crypto" | "metal", code, name).catch(() => null);
    }
    const asset = upsertAsset({
      type: type as "stock" | "crypto" | "metal",
      market: type === "stock" ? market : "ASSET",
      code,
      name,
      url: url ?? "",
      source: "manual"
    });
    return NextResponse.json({ asset });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "添加失败" }, { status: 500 });
  }
}
