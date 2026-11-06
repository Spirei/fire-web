import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const SEC_UA = "fire-web company profile contact@example.com";
const CURATED: Record<string, { founded?: string; website?: string; description?: string }> = {
  AAPL: { founded: "1976", website: "https://www.apple.com/", description: "苹果公司设计、制造和销售智能手机、个人电脑、平板电脑、可穿戴设备及配件，业务遍及全球。公司主要产品包括 iPhone、Mac、iPad、AirPods、Apple Watch 和 Apple Vision Pro，并通过 App Store、Apple Music、iCloud、Apple TV+ 与 AppleCare 等平台和服务构建软硬件生态。" },
  MSFT: { founded: "1975", website: "https://www.microsoft.com/", description: "微软开发并提供软件、云服务、设备与人工智能产品，核心业务涵盖 Microsoft 365、Azure、Windows、LinkedIn、Dynamics、Xbox 以及面向企业和个人的生产力与安全解决方案。" },
  META: { founded: "2004", website: "https://about.meta.com/", description: "Meta Platforms 运营 Facebook、Instagram、Messenger 和 WhatsApp 等社交平台，并通过广告、人工智能、虚拟现实与增强现实产品连接全球用户和企业。" },
  GOOGL: { founded: "1998", website: "https://abc.xyz/", description: "Alphabet 是 Google 的母公司，业务涵盖搜索、数字广告、YouTube、Android、Chrome、Google Cloud、人工智能以及自动驾驶等创新项目。" },
  GOOG: { founded: "1998", website: "https://abc.xyz/", description: "Alphabet 是 Google 的母公司，业务涵盖搜索、数字广告、YouTube、Android、Chrome、Google Cloud、人工智能以及自动驾驶等创新项目。" },
  AMZN: { founded: "1994", website: "https://www.amazon.com/", description: "亚马逊经营全球电子商务平台，并通过 AWS 提供云计算服务，同时布局数字内容、广告、物流、智能设备与人工智能产品。" },
  NVDA: { founded: "1993", website: "https://www.nvidia.com/", description: "英伟达设计计算平台与半导体产品，核心业务涵盖 GPU、数据中心、人工智能、专业可视化、游戏和汽车计算。" },
  TSLA: { founded: "2003", website: "https://www.tesla.com/", description: "特斯拉设计、制造和销售电动汽车、能源存储系统与太阳能产品，并开发自动驾驶、充电网络和相关软件服务。" }
};
const INDUSTRY_ZH: Record<string, string> = {
  "Electronic Computers": "电子计算机",
  "Prepackaged Software": "软件",
  "Semiconductors & Related Devices": "半导体及相关器件",
  "Motor Vehicles & Passenger Car Bodies": "汽车制造",
  "Retail-Catalog & Mail-Order Houses": "电子商务与零售",
  "Services-Computer Programming, Data Processing, Etc.": "互联网与数据服务"
};
const KNOWN_CIK: Record<string, { cik: string; title: string }> = {
  AAPL: { cik: "0000320193", title: "Apple Inc." }, MSFT: { cik: "0000789019", title: "Microsoft Corp" },
  META: { cik: "0001326801", title: "Meta Platforms, Inc." }, GOOGL: { cik: "0001652044", title: "Alphabet Inc." },
  GOOG: { cik: "0001652044", title: "Alphabet Inc." }, AMZN: { cik: "0001018724", title: "Amazon.com, Inc." },
  NVDA: { cik: "0001045810", title: "NVIDIA Corp" }, TSLA: { cik: "0001318605", title: "Tesla, Inc." }
};

type SecTicker = { cik_str: number; title: string; ticker: string; exchange: string };
let tickerCache: { at: number; rows: Record<string, SecTicker> } | null = null;

async function secTickers() {
  if (tickerCache && Date.now() - tickerCache.at < 24 * 60 * 60 * 1000) return tickerCache.rows;
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_UA }, next: { revalidate: 86400 }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("SEC tickers failed");
  const rows = await response.json() as Record<string, SecTicker>;
  tickerCache = { at: Date.now(), rows };
  return rows;
}

function fiscalDate(value?: string) {
  if (!value || !/^\d{4}$/.test(value)) return "—";
  return `${Number(value.slice(0, 2))} 月 ${Number(value.slice(2))} 日`;
}

export async function GET(request: Request) {
  if (!rateLimit(`company-profile:${clientIp(request)}`, 80, 60_000) || !rateLimitGlobal("company-profile", 400, 60_000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const market = String(searchParams.get("market") || "").trim().toUpperCase();
  const code = String(searchParams.get("code") || "").trim().toUpperCase();
  if (!market || !/^[A-Z0-9._-]{1,20}$/.test(code)) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  if (market !== "US") return NextResponse.json({ supported: false, market, code, error: "该市场公司资料正在接入" });

  try {
    const known = KNOWN_CIK[code];
    const entry = known ? { cik_str: Number(known.cik), title: known.title, ticker: code, exchange: "" } : Object.values(await secTickers()).find((item) => item.ticker?.toUpperCase() === code);
    if (!entry) return NextResponse.json({ error: "未找到公司档案" }, { status: 404 });
    const cik = known?.cik || String(entry.cik_str).padStart(10, "0");
    const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA, Accept: "application/json" }, next: { revalidate: 86400 }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("SEC profile failed");
    const sec = await response.json();
    const curated = CURATED[code] || {};
    const industry = INDUSTRY_ZH[sec.sicDescription] || sec.sicDescription || "—";
    const secExchange = Array.isArray(sec.exchanges) ? sec.exchanges[0] : "";
    const description = curated.description || `${sec.name || entry.title}是一家在${entry.exchange || "美国证券市场"}上市的公司，主要从事${industry === "—" ? "相关产品与服务" : industry}业务。`;
    return NextResponse.json({
      supported: true,
      source: "SEC EDGAR",
      company: sec.name || entry.title,
      symbol: `${code}.US`,
      exchange: secExchange === "Nasdaq" ? "纳斯达克全球精选市场" : secExchange === "NYSE" ? "纽约证券交易所" : secExchange || "美国证券市场",
      founded: curated.founded || "—",
      industry,
      fiscalYearEnd: fiscalDate(sec.fiscalYearEnd),
      website: curated.website || sec.website || "",
      description,
      address: sec.addresses?.business ? [sec.addresses.business.street1, sec.addresses.business.city, sec.addresses.business.stateOrCountry, sec.addresses.business.zipCode].filter(Boolean).join(", ") : "",
      phone: sec.phone || ""
    });
  } catch {
    return NextResponse.json({ error: "公司资料获取失败，请稍后重试" }, { status: 502 });
  }
}
