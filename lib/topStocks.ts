import fs from "node:fs";
import path from "node:path";

export type TopMarket = "US" | "HK" | "CN" | "JP" | "KR" | "ALL";

export interface TopStock {
  market: "US" | "HK" | "CN" | "JP" | "KR" | "ASSET";
  code: string;
  name: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  logo: string;
  type?: "stock" | "crypto" | "metal";
  /** 排名较上次抓取的变化：正数=上升几位，负数=下降几位，null=暂无历史 */
  rankChange?: number | null;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const EM_HEADERS = { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" };
const CMC_BASE = "https://companiesmarketcap.com";

const CACHE_FILE = path.join(process.cwd(), "data", "top-stocks-cache.json");
const cache: Record<string, { items: TopStock[]; at: number; prevRank?: Record<string, number> }> = {};

// 磁盘持久化：服务重启不丢缓存，素材库 / 全球预览进入时秒出（不再每次重启后重新抓取外部源）
function loadDiskCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { items: TopStock[]; at: number; prevRank?: Record<string, number> }>;
    if (parsed && typeof parsed === "object") {
      Object.keys(parsed).forEach((k) => {
        if (Array.isArray(parsed[k]?.items) && typeof parsed[k].at === "number") cache[k] = parsed[k];
      });
    }
  } catch {
    /* 无缓存或损坏，忽略 */
  }
}

function saveDiskCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* 写盘失败不影响请求 */
  }
}

loadDiskCache();

const EM_FS: Record<"US" | "HK" | "CN", string> = {
  US: "m:105,m:106,m:107",
  HK: "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:8",
  CN: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
};

const CMC_PAGES: Record<"JP" | "KR" | "ALL", string> = {
  JP: "/japan/largest-companies-in-japan-by-market-cap/",
  KR: "/south-korea/largest-companies-in-south-korea-by-market-cap/",
  ALL: "/assets-by-market-cap/"
};

// 按代码后缀识别市场（companiesmarketcap 格式：AAPL / 1398.HK / 600519.SS / 7203.T / 005930.KS）
function marketOfCode(code: string): TopStock["market"] {
  const c = code.toUpperCase();
  if (c.endsWith(".HK")) return "HK";
  if (c.endsWith(".SS") || c.endsWith(".SZ")) return "CN";
  if (c.endsWith(".T")) return "JP";
  if (c.endsWith(".KS") || c.endsWith(".KQ")) return "KR";
  return "US";
}

function emLogo(market: string, code: string): string {
  if (market === "US") return `https://g.foolcdn.com/art/companylogos/square/${code.toUpperCase()}.png`;
  if (market === "CN") {
    const ex = /^6/.test(code) ? "SS" : /^[03]/.test(code) ? "SZ" : "";
    return ex ? `https://assets.parqet.com/logos/symbol/${code}.${ex}` : "";
  }
  return `https://assets.parqet.com/logos/symbol/${code}.HK`;
}

function cmcLogo(code: string): string {
  return `${CMC_BASE}/img/company-logos/64/${code}.png`;
}

const TRADINGVIEW_METAL_LOGOS: Record<string, string> = {
  GOLD: "https://s3-symbol-logo.tradingview.com/metal/gold--big.svg",
  SILVER: "https://s3-symbol-logo.tradingview.com/metal/silver--big.svg",
  PLAT: "https://s3-symbol-logo.tradingview.com/metal/platinum--big.svg",
  PALLAD: "https://s3-symbol-logo.tradingview.com/metal/palladium--big.svg"
};

async function fetchEmTop(market: "US" | "HK" | "CN"): Promise<TopStock[]> {
  const qs = `pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20&fs=${EM_FS[market]}&fields=f12,f14,f2,f3,f20`;
  let data: unknown = null;
  for (const host of ["push2delay.eastmoney.com", "push2.eastmoney.com"]) {
    try {
      const res = await fetch(`https://${host}/api/qt/clist/get?${qs}`, { headers: EM_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`东方财富返回 ${res.status}`);
      data = await res.json().catch(() => null);
      if (data) break;
    } catch {
      /* 尝试下一个主机 */
    }
  }
  if (!data) throw new Error("东方财富行情接口不可用");
  const diff = (data as { data?: { diff?: Record<string, unknown>[] } })?.data?.diff;
  if (!Array.isArray(diff)) throw new Error("东方财富返回格式异常");
  return diff.map((r): TopStock => {
    const code = String(r.f12 ?? "");
    const priceRaw = r.f2;
    const price = priceRaw === "-" || priceRaw === null || priceRaw === undefined ? null : Number(priceRaw);
    return {
      market,
      code,
      name: String(r.f14 ?? code),
      marketCap: Number(r.f20) || 0,
      price: Number.isFinite(price as number) ? (price as number) : null,
      changePct: Number(r.f3) || 0,
      logo: emLogo(market, code)
    };
  });
}

async function fetchCmcPage(market: "JP" | "KR" | "ALL"): Promise<TopStock[]> {
  const url = `${CMC_BASE}${CMC_PAGES[market]}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`companiesmarketcap 返回 ${res.status}`);
  const html = await res.text();
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const items: TopStock[] = [];
  for (const row of rows) {
    if (items.length >= 100) break;
    if (!row.includes('company-name">')) continue; // 跳过广告行/表头
    const name = row.match(/company-name">([^<]*)</)?.[1]?.trim();
    const code = row.match(/company-code"><span class="rank d-none"><\/span>([^<]*)</)?.[1]?.trim();
    if (!name || !code) continue;
    const trClass = row.match(/<tr class="([^"]*)"/)?.[1] ?? "";
    const type: TopStock["type"] = trClass.includes("crypto") ? "crypto" : trClass.includes("precious") ? "metal" : "stock";
    const m = market === "ALL" ? marketOfCode(code) : market;
    let capRaw: string | undefined;
    let priceRaw: string | undefined;
    let pctRaw: string | undefined;
    if (market === "ALL") {
      // 资产页：市值/价格/涨跌幅都在 td 的 data-sort 属性（价格单位是美分）
      const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
      // 结构：[0]排名 [1]名称/Logo [2]市值 [3]价格(美分) [4]涨跌幅(基点)
      capRaw = tds[2]?.match(/data-sort="([\d.]+)"/)?.[1];
      priceRaw = tds[3]?.match(/data-sort="([-\d.]+)"/)?.[1];
      pctRaw = tds[4]?.match(/data-sort="([-\d.]+)"/)?.[1];
    } else {
      // 国家/公司页：旧结构
      capRaw = row.match(/class="td-right" data-sort="(\d+)"><span class="currency-symbol-left">/)?.[1];
      priceRaw = row.match(/data-sort="\d+">\$([\d,\.]+)<\/td>/)?.[1];
      pctRaw = row.match(/([\d\.]+)%<\/span>/)?.[1];
    }
    items.push({
      market: m,
      code,
      name,
      marketCap: Number(capRaw) || 0,
      price:
        market === "ALL" && priceRaw != null && priceRaw !== ""
          ? Number(priceRaw) / 100
          : priceRaw
            ? Number(priceRaw.replace(/,/g, ""))
            : null,
      changePct: pctRaw != null && pctRaw !== "" ? Number(pctRaw) / (market === "ALL" ? 100 : 1) : null,
      logo: type === "metal" ? TRADINGVIEW_METAL_LOGOS[code] || "" : cmcLogo(code),
      type
    });
  }
  if (items.length === 0) throw new Error("companiesmarketcap 解析失败");
  return items;
}

export async function getTopStocks(market: TopMarket): Promise<{ items: TopStock[]; updatedAt: string }> {
  const cached = cache[market];
  const ttl = market === "JP" || market === "KR" || market === "ALL" ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000;
  if (cached && Date.now() - cached.at < ttl) {
    return { items: cached.items, updatedAt: new Date(cached.at).toISOString() };
  }
  const items =
    market === "US" || market === "HK" || market === "CN"
      ? await fetchEmTop(market)
      : await fetchCmcPage(market);
  // 与上次抓取的排名对比，计算每位品种的排名变化（正=上升，负=下降，无历史=null）
  const prevRank = cache[market]?.prevRank ?? {};
  const ranked = items.map((it, i) => ({
    ...it,
    rankChange: prevRank[it.code] === undefined ? null : prevRank[it.code] - (i + 1)
  }));
  const nextRank: Record<string, number> = {};
  items.forEach((it, i) => {
    nextRank[it.code] = i + 1;
  });
  cache[market] = { items: ranked, at: Date.now(), prevRank: nextRank };
  saveDiskCache();
  return { items: ranked, updatedAt: new Date().toISOString() };
}
