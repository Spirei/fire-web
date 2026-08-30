/* ---------- 名人持仓数据源 ----------
 *
 * 技术栈延伸：Node.js 服务端数据管道
 *  1. SEC EDGAR JSON API（data.sec.gov / www.sec.gov）
 *     - 13F-HR：机构投资人（如伯克希尔）季度持仓，读取 InfoTable.xml；
 *     - Form 4：董监高 / 政要持仓变动（佩洛西、黄仁勋等），读取 ownershipDocument；
 *  2. Dataroma：聚合 13F / 13G / Form 4 的第三方站点（当前网络不可达，作为参考数据源保留）；
 *  3. 腾讯行情接口（lib/quotes）为真实持仓补充实时现价 / 涨跌幅；
 *  4. 24 小时文件缓存（data/celebs-cache.json）+ 示例数据兜底，任何一步失败都不影响页面展示。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CELEBS, type Celeb, type CelebDataSource, type CelebHolding } from "./celebs";
import { listCelebRows, seedCelebsIfEmpty, type CelebRow, type CelebSourceKind } from "./celebsStore";
import { proxyFetch } from "./net";
import { fetchQuotes } from "./quotes";
import { resolveEtfMarketCap } from "./etfMarketCap";

const SEC_UA = "Fire Research (self-hosted stock journal; contact: admin@fire.local)";
const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(CACHE_DIR, "celebs-cache.json");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时
const PARTIAL_TTL = 6 * 60 * 60 * 1000; // 部分失败时缩短缓存，尽快重试
/** 缓存结构版本；升版（旧缓存缺字段）时强制对 13F 类名人重算一次，补齐「报告期 / 环比 / 新进」 */
const CACHE_SCHEMA = 4;
const REQ_TIMEOUT = 8000;
const REQ_DELAY = 350; // SEC 限流：10 req/s，留足余量
const MAX_RETRY = 2; // SEC 网络不稳（尤其 www.sec.gov / 代理预热），失败重试

/* 常见持仓名称 → 代码（13F InfoTable 只有公司名 + CUSIP，没有代码；
   这里内置常见映射，未命中的再走腾讯联想接口按名称查询） */
const TICKER_BY_NAME: Record<string, string> = {
  "apple": "AAPL",
  "american express": "AXP",
  "coca-cola": "KO",
  "bank of america": "BAC",
  "chevron": "CVX",
  "occidental petroleum": "OXY",
  "chubb": "CB",
  "moody": "MCO",
  "kroger": "KR",
  "verisign": "VRSN",
  "charter communications": "CHTR",
  "microsoft": "MSFT",
  "nvidia": "NVDA",
  "amazon": "AMZN",
  "alphabet": "GOOGL",
  "meta platforms": "META",
  "tesla": "TSLA",
  "netflix": "NFLX",
  "adobe": "ADBE",
  "salesforce": "CRM",
  "broadcom": "AVGO",
  "micron technology": "MU",
  "advanced micro devices": "AMD",
  "taiwan semiconductor": "TSM",
  "cognizant": "CTSH",
  "coinbase": "COIN",
  "roku": "ROKU",
  "crowdstrike": "CRWD",
  "zoom video": "ZM",
  "palantir": "PLTR",
  "unitedhealth": "UNH",
  "jpmorgan": "JPM",
  "wells fargo": "WFC",
  "citigroup": "C",
  "goldman sachs": "GS",
  "morgan stanley": "MS",
  "linde": "LIN",
  "costco": "COST",
  "walmart": "WMT",
  "visa": "V",
  "mastercard": "MA",
  "home depot": "HD",
  "procter & gamble": "PG",
  "johnson & johnson": "JNJ",
  "merck": "MRK",
  "pfizer": "PFE",
  "abbvie": "ABBV",
  "exxon mobil": "XOM",
  "intel": "INTC",
  "disney": "DIS",
  "uber": "UBER",
  "ibm": "IBM",
  "oracle": "ORCL",
  "mcdonald": "MCD",
  "starbucks": "SBUX",
  "berkshire": "BRK.B",
  "trump media": "DJT",
  "pddu": "PDD",
  "pinduoduo": "PDD",
  "netease": "NTES",
  "baidu": "BIDU",
  "alibaba": "BABA",
  "tencent": "TCEHY",
  "t-mobile": "TMUS",
  "verizon": "VZ",
  "at&t": "T",
  "caterpillar": "CAT",
  "general electric": "GE",
  "boeing": "BA",
  "lululemon": "LULU",
  "shopify": "SHOP",
  "square": "SQ",
  "block": "XYZ",
  "robynhood": "HOOD",
  "robinhood": "HOOD",
  "pdd": "PDD",
  "snowflake": "SNOW",
  "synopsys": "SNPS",
  "tempus": "TEM",
  "occidental": "OXY",
  "circle internet": "CRCL",
  "credo": "CRDO",
  "innodata": "INOD",
  "coherent": "COHR",
  "coreweave": "CRWV",
  "generate biomedicines": "GNTA",
  "nebius": "NBIS",
  "nokia": "NOK",
  "space exploration": "SPCX",
  "spacex": "SPCX"
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function secFetch(url: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    await sleep(REQ_DELAY);
    try {
      const res = await proxyFetch(url, {
        headers: { "User-Agent": SEC_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(REQ_TIMEOUT)
      });
      if (res.ok) return res;
      lastErr = new Error(`SEC ${res.status} ${url.slice(0, 80)}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(400 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function lookupCik(entity: string): Promise<string | null> {
  // SEC 公司检索（Atom 输出）→ CIK 反查（不限定 13F，个人申报人只提交 Form 3/4 也能查到）
  const q = encodeURIComponent(entity);
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${q}&dateb=&owner=include&count=10&output=atom`;
  const res = await proxyFetch(url, {
    headers: { "User-Agent": SEC_UA, Accept: "application/atom+xml" },
    signal: AbortSignal.timeout(REQ_TIMEOUT)
  });
  if (!res.ok) return null;
  const xml = await res.text();
  const m = /<cik>(\d{10})<\/cik>/i.exec(xml);
  return m?.[1] ?? null;
}

function resolveTicker(name: string): string | null {
  const key = name.toLowerCase().replace(/[^a-z0-9&.\s]/g, "").replace(/\s+/g, " ").trim();
  for (const [k, v] of Object.entries(TICKER_BY_NAME)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  // 常见形式：名称 + "COM" / "CL A" 等后缀
  const firstWord = key.split(" ")[0];
  if (TICKER_BY_NAME[firstWord]) return TICKER_BY_NAME[firstWord];
  return null;
}

interface FetchedCeleb {
  holdings: CelebHolding[];
  updated: string;
  reportQuarter?: string;
  source: CelebDataSource;
  accession?: string;
}

/** SEC 13F 报告期（reportDate）→ 季度标签，如 2026-06-30 → 2026Q2 */
function quarterFromReport(reportDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(reportDate);
  if (!m) return "";
  const month = Number(m[2]);
  const q = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  return `${m[1]}Q${q}`;
}

/** 抓取某份 13F 申报里的明细表 XML（主文档 / InfoTable / 按名字匹配 / 整份 .txt 兜底） */
async function fetch13FInfoXml(cik: string, acc: string, primaryName?: string): Promise<string> {
  const index = await (await secFetch(`https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${acc}/index.json`)).json();
  const items: { name: string }[] = Array.isArray(index?.directory?.item) ? index.directory.item : [];
  const candidates: string[] = [];
  if (primaryName && !candidates.includes(primaryName)) candidates.push(primaryName);
  items.forEach((it) => {
    const n = it.name.toLowerCase();
    if (n.includes("infotable") || n.includes("form13f") || n.endsWith(".xml")) {
      if (!candidates.includes(it.name)) candidates.push(it.name);
    }
  });
  for (const name of candidates) {
    const raw = await (
      await secFetch(`https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${acc}/${name}`)
    ).text();
    if (/<[a-zA-Z0-9_:]*info(?:rmation)?table/i.test(raw)) return raw;
  }
  const txt = items.find((it) => it.name.toLowerCase().endsWith(".txt"));
  if (txt) {
    const raw = await (
      await secFetch(`https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${acc}/${txt.name}`)
    ).text();
    if (/<[a-zA-Z0-9_:]*info(?:rmation)?table/i.test(raw)) return raw;
  }
  return "";
}

/** 解析 13F 明细表 → 按代码合并后的权重列表（代码 → { name, value, weight }，按市值降序、全量） */
function parse13FList(xml: string): { code: string; name: string; weight: number }[] {
  const rows = [...xml.matchAll(/<(?:[a-zA-Z0-9_]+:)?infoTable[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?infoTable>/gi)].map((m) => m[1]);
  const byTicker = new Map<string, { name: string; value: number }>();
  for (const row of rows) {
    // X02 新格式使用 ns1: 命名空间前缀，兼容旧的无前缀与带属性写法
    const name = /<(?:[a-zA-Z0-9_]+:)?nameOfIssuer>([^<]*)<\/(?:[a-zA-Z0-9_]+:)?nameOfIssuer>/i.exec(row)?.[1]?.trim();
    const value = /<(?:[a-zA-Z0-9_]+:)?value>([^<]*)<\/(?:[a-zA-Z0-9_]+:)?value>/i.exec(row)?.[1]?.trim();
    if (!name || !value) continue;
    const code = resolveTicker(name);
    if (!code) continue;
    const prev = byTicker.get(code);
    if (prev) prev.value += Number(value);
    else byTicker.set(code, { name, value: Number(value) });
  }
  const total = [...byTicker.values()].reduce((s, r) => s + r.value, 0);
  return [...byTicker.values()]
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ code: resolveTicker(r.name)!, name: r.name, weight: total > 0 ? (r.value / total) * 100 : 0 }));
}

async function fetch13F(cik: string, cachedAccession?: string): Promise<FetchedCeleb | "unchanged"> {
  const subs = await (await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)).json();
  const recent = subs.filings.recent;
  const idx13F: number[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i].startsWith("13F-HR")) idx13F.push(i);
  }
  if (idx13F.length === 0) throw new Error("无 13F-HR 记录");
  const idx = idx13F[0];
  const acc = recent.accessionNumber[idx].replace(/-/g, "");
  if (cachedAccession && cachedAccession === acc) return "unchanged";
  const filingDate = recent.filingDate[idx] ?? "";
  const reportDate = recent.reportDate[idx] ?? "";
  const xml = await fetch13FInfoXml(cik, acc, recent.primaryDocument[idx]);
  if (!xml) throw new Error("未找到 13F 明细表");
  const latestList = parse13FList(xml);
  if (latestList.length === 0) throw new Error("13F 明细为空");

  // 上一份 13F 的占比，用于计算「较上季增加多少百分点」；解析失败则无 delta
  let prevWeights = new Map<string, number>();
  if (idx13F[1] >= 0) {
    try {
      const prevAcc = recent.accessionNumber[idx13F[1]].replace(/-/g, "");
      const prevXml = await fetch13FInfoXml(cik, prevAcc, recent.primaryDocument[idx13F[1]]);
      if (prevXml) prevWeights = new Map(parse13FList(prevXml).map((r) => [r.code, r.weight]));
    } catch {
      prevWeights = new Map();
    }
  }

  const holdings: CelebHolding[] = latestList.slice(0, 8).map((r) => ({
    code: r.code,
    name: r.name,
    market: "US",
    weight: r.weight,
    weightDelta: prevWeights.size > 0 && prevWeights.has(r.code) ? r.weight - prevWeights.get(r.code)! : undefined,
    isNew: prevWeights.size > 0 && !prevWeights.has(r.code),
    price: 0,
    changePct: 0,
    target: 0
  }));
  if (holdings.length === 0) throw new Error("13F 明细无法匹配代码");
  return { holdings, updated: `${filingDate.slice(5).replace("-", "/")} 更新`, reportQuarter: quarterFromReport(reportDate), source: "sec13f", accession: acc };
}

/** 解析单份 Form 4 XML 的股票持仓（nonDerivativeHolding），按代码合并、保留最大持股 */
function parseForm4Positions(xml: string): Map<string, { name: string; shares: number; price: number }> {
  // Form 4 的 securityTitle 通常是「Common Stock」等通用类别，需用申报里的发行人代码兜底
  const issuerSymbol = /<issuerTradingSymbol>([^<]*)<\/issuerTradingSymbol>/i.exec(xml)?.[1]?.trim();
  const issuerName = /<issuerName>([^<]*)<\/issuerName>/i.exec(xml)?.[1]?.trim();
  const fallbackCode = issuerSymbol || resolveTicker(issuerName ?? "");
  const docs = [...xml.matchAll(/<nonDerivativeHolding>([\s\S]*?)<\/nonDerivativeHolding>/gi)].map((m) => m[1]);
  const seen = new Map<string, { name: string; shares: number; price: number }>();
  for (const d of docs) {
    const title = /<securityTitle>[\s\S]*?<value>([^<]*)<\/value>/i.exec(d)?.[1]?.trim();
    const shares = Number(/<postTransactionAmounts>[\s\S]*?<value>([^<]*)<\/value>/i.exec(d)?.[1]);
    const price = Number(/<transactionPricePerShare>[\s\S]*?<value>([^<]*)<\/value>/i.exec(d)?.[1]);
    if (!title || !Number.isFinite(shares)) continue;
    const code = resolveTicker(title) || fallbackCode;
    if (!code) continue;
    const prev = seen.get(code);
    if (prev) {
      // 同一证券可能有多行（直接/间接持有），累加得到总持股
      prev.shares += shares;
      if (!prev.price && Number.isFinite(price)) prev.price = price;
    } else {
      seen.set(code, { name: issuerName || title, shares, price: Number.isFinite(price) ? price : 0 });
    }
  }
  return seen;
}

/** 抓取申报内的原始 XML 文档：SEC 部分 Form 4 的 primaryDocument 带 xsl 前缀会返回渲染后的 HTML，
 *  这里优先尝试申报根目录的原始 XML（basename），失败再退回给出的路径。 */
async function fetchRawArchiveDoc(cik: string, acc: string, doc?: string): Promise<string> {
  if (!doc) return "";
  const numericCik = cik.replace(/^0+/, "");
  const basename = doc.split("/").pop() ?? doc;
  const paths = [...new Set([doc, basename])];
  for (const path of paths) {
    try {
      const res = await secFetch(`https://www.sec.gov/Archives/edgar/data/${numericCik}/${acc}/${path}`);
      const text = await res.text();
      if (/<ownershipDocument|<\?xml/i.test(text)) return text;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return "";
}

function form4WeightList(seen: Map<string, { name: string; shares: number; price: number }>): { code: string; name: string; weight: number }[] {
  const list = [...seen.values()];
  const total = list.reduce((s, h) => s + h.shares * (h.price || 1), 0);
  return list.map((h) => ({ code: resolveTicker(h.name)!, name: h.name, weight: total > 0 ? (h.shares * (h.price || 1)) / total * 100 : 0 }));
}

async function fetchForm4(cik: string): Promise<FetchedCeleb> {
  const subs = await (await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)).json();
  const recent = subs.filings.recent;
  // Form 4 修正件为 4/A，一并纳入；按时间倒序找最近一次「含股票持仓」的申报，跳过只有期权/衍生品的申报
  const idxs: number[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    if (form === "4" || form.startsWith("4/")) idxs.push(i);
  }
  if (idxs.length === 0) throw new Error("无 Form 4 记录");

  let latest: { code: string; name: string; weight: number }[] = [];
  let prevWeights = new Map<string, number>();
  let filingDate = "";
  let found = 0;
  for (const idx of idxs) {
    const acc = recent.accessionNumber[idx].replace(/-/g, "");
    const primary = recent.primaryDocument[idx];
    if (!primary) continue;
    let xml = "";
    xml = await fetchRawArchiveDoc(cik, acc, primary);
    if (!xml) continue;
    const positions = parseForm4Positions(xml);
    const wl = positions.size > 0 ? form4WeightList(positions) : [];
    if (wl.length === 0) continue;
    if (found === 0) {
      latest = wl;
      filingDate = recent.filingDate[idx] ?? "";
      found = 1;
    } else {
      prevWeights = new Map(wl.map((r) => [r.code, r.weight]));
      found = 2;
      break;
    }
  }
  if (latest.length === 0) throw new Error("Form 4 无可解析持仓");

  const holdings: CelebHolding[] = latest.slice(0, 8).map((r) => ({
    code: r.code,
    name: r.name,
    market: "US",
    weight: r.weight,
    weightDelta: prevWeights.size > 0 && prevWeights.has(r.code) ? r.weight - prevWeights.get(r.code)! : undefined,
    isNew: prevWeights.size > 0 && !prevWeights.has(r.code),
    price: 0,
    changePct: 0,
    target: 0
  }));
  return { holdings, updated: `${filingDate.slice(5).replace("-", "/")} 更新`, source: "secform4" };
}

async function fetchOne(
  cfg: { kind: CelebSourceKind; cik?: string; entity?: string },
  cachedAccession?: string
): Promise<FetchedCeleb | "unchanged" | null> {
  try {
    let cik = cfg.cik;
    if (!cik && cfg.entity) {
      cik = (await lookupCik(cfg.entity)) ?? undefined;
    }
    if (!cik) return null;
    return cfg.kind === "13f" ? await fetch13F(cik, cachedAccession) : await fetchForm4(cik);
  } catch {
    return null; // 网络 / 解析失败 → 兜底
  }
}

interface CacheShape {
  schema?: number;
  at: number;
  ttl: number;
  celebs: Celeb[];
  detail: Record<string, string>;
  /** 每位名人的最近一次成功拉取时间（ISO），用于按人增量刷新 */
  fetchedAt: Record<string, string>;
  /** 每位名人的最新 13F 申报号（同一申报号不重复解析） */
  lastAccession: Record<string, string>;
  /** 最近一次定时检查的日期（YYYY-MM-DD） */
  scheduledDate: string;
}

function emptyCache(): CacheShape {
  return {
    schema: CACHE_SCHEMA,
    at: 0,
    ttl: CACHE_TTL,
    celebs: [],
    detail: {},
    fetchedAt: {},
    lastAccession: {},
    scheduledDate: ""
  };
}

function readCache(): CacheShape | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<CacheShape>;
    if (!Array.isArray(parsed.celebs)) return null;
    return {
      ...emptyCache(),
      ...parsed,
      schema: typeof parsed.schema === "number" ? parsed.schema : 0, // 无版本字段视为旧缓存，触发回填
      fetchedAt: parsed.fetchedAt ?? {},
      lastAccession: parsed.lastAccession ?? {},
      scheduledDate: parsed.scheduledDate ?? ""
    };
  } catch {
    return null;
  }
}

function writeCache(shape: CacheShape) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(shape));
  } catch {
    /* 忽略缓存写入失败 */
  }
}

/* 默认数据有效期（小时）：13F 季度申报 168h（7 天）查一次新申报；
   Form 4 交易随时可能发生 24h；ARK（木头姐）每日披露 24h；手动数据 720h（30 天）。
   名人管理里可按人覆盖（refreshHours > 0 时优先）。 */
export function defaultRefreshHours(row: Pick<CelebRow, "id" | "sourceKind">): number {
  if (row.id === "cathie") return 24;
  if (row.sourceKind === "13f") return 168;
  if (row.sourceKind === "form4") return 24;
  return 720;
}

function celebTtl(row: CelebRow): number {
  const hours = row.refreshHours > 0 ? row.refreshHours : defaultRefreshHours(row);
  return hours * 60 * 60 * 1000;
}

function isCelebFresh(row: CelebRow, cache: CacheShape): boolean {
  const fetched = cache.fetchedAt[row.id];
  if (!fetched) return false;
  return Date.now() - new Date(fetched).getTime() < celebTtl(row);
}

async function enrichQuotes(celebs: Celeb[]): Promise<Celeb[]> {
  const items: { id: string; market: string; code: string }[] = [];
  celebs.forEach((c) => c.holdings.forEach((h) => items.push({ id: `${c.id}:${h.code}`, market: "US", code: h.code })));
  if (items.length === 0) return celebs;
  try {
    const quotes = await fetchQuotes(items.map((it) => ({ id: it.id, market: it.market, code: it.code })));
    return Promise.all(celebs.map(async (c) => ({
      ...c,
      holdings: await Promise.all(c.holdings.map(async (h) => {
        const q = quotes[`${c.id}:${h.code}`];
        if (!q) return h;
        const price = q.price ?? h.price;
        let marketCap = q.marketCap ?? h.marketCap;
        // 与个股详情页一致：ETF / 无市值标的用 resolveEtfMarketCap 补全（公司当前总市值）
        if (!marketCap && Number.isFinite(price) && price > 0) {
          try {
            marketCap = (await resolveEtfMarketCap(h.market, h.code, price)) ?? marketCap;
          } catch {
            /* 忽略，保留原值 */
          }
        }
        return {
          ...h,
          price,
          changePct: q.changePct ?? h.changePct,
          name: q.name || h.name,
          marketCap
        };
      }))
    })));
  } catch {
    return celebs;
  }
}

export interface CelebsResult {
  celebs: Celeb[];
  source: "sec-edgar" | "cache" | "sample";
  updatedAt: string;
  detail: Record<string, string>;
}

/* 每个名人的数据标签统一使用名人管理里配置的「来源标签」，缺失时按来源类型兜底 */
function fillDetail(rows: CelebRow[], detail: Record<string, string>): Record<string, string> {
  const out = { ...detail };
  rows.forEach((row) => {
    out[row.id] =
      row.sourceLabel ||
      (row.sourceKind === "none" ? "公开披露 · 示例数据" : "示例数据（SEC 暂不可达）");
  });
  return out;
}

/* 名人头像覆盖：随镜像发布的默认映射 + 运行时上传映射（后者优先） */
export function getCelebAvatars(): Record<string, string> {
  let defaults: Record<string, string> = {};
  try {
    defaults = JSON.parse(
      readFileSync(path.join(process.cwd(), "public", "uploads", "celebs", "default-avatars.json"), "utf8")
    ) as Record<string, string>;
  } catch {
    // 兼容尚未带默认映射的旧部署
  }
  try {
    const uploaded = JSON.parse(readFileSync(path.join(CACHE_DIR, "celebs-avatars.json"), "utf8")) as Record<string, string>;
    return { ...defaults, ...uploaded };
  } catch {
    return defaults;
  }
}

/* 数据库行 → 展示用 Celeb（示例数据兜底，SEC 成功后再替换持仓） */
function rowToCeleb(row: CelebRow): Celeb {
  const points = Array.isArray(row.returns?.points) && row.returns.points.length > 0 ? row.returns.points : [0];
  // 对比基准指数：新结构 benchmarks 优先；老数据用 spxPoints 兜底归一为标普500
  const rawBench = Array.isArray(row.returns?.benchmarks) && row.returns.benchmarks.length > 0
    ? row.returns.benchmarks
    : Array.isArray(row.returns?.spxPoints) && row.returns.spxPoints.length > 1
      ? [{ code: "SPX", name: "标普500指数", y1: row.returns?.spxY1 ?? 0, points: row.returns.spxPoints }]
      : [];
  const d = new Date(row.updatedAt || Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    gain250: Number(points[points.length - 1] ?? 0),
    updated: `${mm}/${dd} 更新`,
    avatar: row.avatar,
    dataSource: "sample",
    stockIcons: row.stockIcons ?? {},
    trades: (row.trades ?? []).map((t) => ({ ...t })),
    holdings: (row.holdings ?? []).map((h) => ({ ...h })),
    returns: {
      y1: row.returns?.y1 ?? 0,
      y3: row.returns?.y3 ?? 0,
      y5: row.returns?.y5 ?? 0,
      spxY1: row.returns?.spxY1 ?? 0,
      points: points.map((n) => Number(n)),
      spxPoints: (row.returns?.spxPoints ?? []).map((n) => Number(n)),
      benchmarks: rawBench.map((b) => ({ code: b.code, name: b.name, y1: Number(b.y1) || 0, points: (b.points ?? []).map((n) => Number(n)) }))
    }
  };
}

/* 确保对比基准指数字段存在：旧缓存 / 手动数据没有 benchmarks 时，用 spxPoints 兜底归一为标普500 */
function withBenchmarks(c: Celeb): Celeb {
  const ret = c.returns ?? { y1: 0, y3: 0, y5: 0, spxY1: 0, points: [0], spxPoints: [] };
  const benches =
    Array.isArray(ret.benchmarks) && ret.benchmarks.length > 0
      ? ret.benchmarks
      : Array.isArray(ret.spxPoints) && ret.spxPoints.length > 1
        ? [{ code: "SPX", name: "标普500指数", y1: ret.spxY1 ?? 0, points: ret.spxPoints }]
        : [];
  return { ...c, returns: { ...ret, benchmarks: benches } };
}

/* 增量刷新：只拉取过期（按人 TTL）或从未拉过的名人，13F 同申报号直接跳过解析 */
async function refreshCelebs(rows: CelebRow[], cache: CacheShape | null, forceStale = false): Promise<{ celebs: Celeb[]; detail: Record<string, string>; anyReal: boolean }> {
  const working: CacheShape = cache ?? emptyCache();
  const now = Date.now();
  const staleRows = rows.filter((r) => r.sourceKind !== "none" && (forceStale || !isCelebFresh(r, working)));

  let secReachable = staleRows.length > 0;
  if (secReachable) {
    // 快速连通性探测：SEC 不可达时尽快兜底（最多 2 次、每次 3 秒）
    secReachable = false;
    for (let i = 0; i < 2 && !secReachable; i++) {
      try {
        const probe = await proxyFetch("https://data.sec.gov/submissions/CIK0001067983.json", {
          headers: { "User-Agent": SEC_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(3000)
        });
        secReachable = probe.ok;
      } catch {
        secReachable = false;
      }
      if (!secReachable && i < 1) await sleep(500);
    }
  }

  const fetched = secReachable
    ? await Promise.all(
        staleRows.map((r) => fetchOne({ kind: r.sourceKind, cik: r.cik, entity: r.entity }, forceStale ? undefined : working.lastAccession[r.id]))
      )
    : staleRows.map(() => null);

  const detail: Record<string, string> = { ...working.detail };
  let anyReal = false;
  for (let i = 0; i < staleRows.length; i++) {
    const row = staleRows[i];
    const f = fetched[i];
    if (f === "unchanged") {
      // 13F 申报号未变：数据无变化，仅续期。旧缓存没有「环比 / 新进 / 报告期」字段时，
      // 强制用新逻辑重拉一次（传空 accession 重新解析最新 + 上一季度）补齐字段；失败保留原数据。
      const celeb = working.celebs.find((c) => c.id === row.id);
      const needsBackfill =
        !!celeb &&
        celeb.dataSource !== "sample" &&
        !celeb.holdings.some((h) => typeof h.weightDelta === "number" || h.isNew);
      if (needsBackfill) {
        try {
          const re = await fetchOne({ kind: row.sourceKind, cik: row.cik, entity: row.entity }, undefined);
          if (re && re !== "unchanged") {
            celeb.holdings = re.holdings;
            celeb.updated = re.updated;
            celeb.dataSource = re.source;
            celeb.reportQuarter = re.reportQuarter;
            if (re.accession) working.lastAccession[row.id] = re.accession;
          }
        } catch {
          /* 回填失败保留原数据 */
        }
      }
      working.fetchedAt[row.id] = new Date(now).toISOString();
      detail[row.id] = row.sourceLabel || "SEC EDGAR";
      continue;
    }
    if (f) {
      anyReal = true;
      detail[row.id] = row.sourceLabel || "SEC EDGAR";
      const celeb = working.celebs.find((c) => c.id === row.id);
      if (celeb) {
        celeb.holdings = f.holdings;
        celeb.updated = f.updated;
        celeb.dataSource = f.source;
        celeb.reportQuarter = f.reportQuarter ?? celeb.reportQuarter;
      } else {
        const base = rowToCeleb(row);
        base.holdings = f.holdings;
        base.updated = f.updated;
        base.dataSource = f.source;
        base.reportQuarter = f.reportQuarter;
        working.celebs.push(base);
      }
      working.fetchedAt[row.id] = new Date(now).toISOString();
      if (f.accession) working.lastAccession[row.id] = f.accession;
    } else {
      detail[row.id] = row.sourceKind === "none" ? "公开披露 · 示例数据" : "示例数据（SEC 暂不可达）";
    }
  }

  // 缓存里补全 DB 中尚未出现（新增）的名人：SEC 拉取失败的不写缓存（避免示例数据冒充缓存，下次仍会重试）
  rows.forEach((row) => {
    if (!working.celebs.find((c) => c.id === row.id)) {
      if (row.sourceKind === "none") {
        working.celebs.push(rowToCeleb(row));
        if (!detail[row.id]) detail[row.id] = "公开披露 · 示例数据";
      } else if (!detail[row.id]) {
        detail[row.id] = "示例数据（SEC 暂不可达）";
      }
    }
  });
  // 按数据库排序
  working.celebs.sort((a, b) => rows.findIndex((r) => r.id === a.id) - rows.findIndex((r) => r.id === b.id));

  // 响应列表：全部行都有展示数据（拉取失败用示例兜底，仅展示、不写缓存）
  let finalCelebs = rows.map((row) => {
    const c = working.celebs.find((x) => x.id === row.id);
    return c ? { ...c } : rowToCeleb(row);
  });
  finalCelebs = await enrichQuotes(finalCelebs);
  const overrides = getCelebAvatars();
  finalCelebs = finalCelebs.map((c) => (overrides[c.id] ? { ...c, avatar: overrides[c.id] } : c));
  // 只把真实（SEC 成功）或手动维护的数据写回缓存，示例兜底不落盘
  working.celebs = finalCelebs.filter((c) => {
    const row = rows.find((r) => r.id === c.id);
    return row && (row.sourceKind === "none" || c.dataSource !== "sample");
  });
  working.at = now;
  working.schema = CACHE_SCHEMA;
  working.ttl = staleRows.some((_, i) => fetched[i] === null) ? PARTIAL_TTL : CACHE_TTL;
  working.detail = detail;
  working.scheduledDate = new Date().toISOString().slice(0, 10);
  writeCache(working);
  return { celebs: finalCelebs, detail, anyReal };
}

export async function getCelebsData(): Promise<CelebsResult> {
  seedCelebsIfEmpty();
  const rows = listCelebRows(true);
  const cache = readCache();
  const overrides = getCelebAvatars();
  // 缓存结构版本落后（如新增「报告期 / 环比 / 新进」字段）时，同步对 13F 类名人重算一次补齐，
  // 避免用户看到旧缓存没有环比/新进标识；其余情况仍走「秒出 + 后台刷新」。
  const schemaOutdated = !!cache && (typeof cache.schema !== "number" || cache.schema < CACHE_SCHEMA);

  if (cache && cache.celebs.length > 0 && !schemaOutdated) {
    // 有缓存：秒出（含自定义头像），后台按人增量刷新过期名人。
    // 返回前统一补齐行情市值（company marketCap / 现价），避免 SEC 拉取失败走示例兜底的名人（如佩洛西）没有市值。
    const celebs = await enrichQuotes(rows.map((row) => {
      const c = cache.celebs.find((x) => x.id === row.id);
      // 旧缓存没有 benchmarks（对比指数）时，用 spxPoints 兜底归一为标普500
      const base = c ? withBenchmarks({ ...c }) : rowToCeleb(row);
      // 头像不从 24h 业务缓存恢复：上传映射最高，其次是数据库当前值。
      // 否则部署后即使 DB 已迁移，旧缓存仍会把原始头像覆盖回来。
      return { ...base, avatar: overrides[base.id] || row.avatar || base.avatar };
    }));
    void scheduleBackgroundRefresh(rows, cache);
    return { celebs, source: "cache", updatedAt: new Date(cache.at).toISOString(), detail: fillDetail(rows, cache.detail) };
  }

  // 首次无缓存 / 旧版本缓存：同步拉取一次（写入缓存后后续均为秒出）
  const fresh = await refreshCelebs(rows, schemaOutdated ? cache : null, schemaOutdated);
  const celebs = fresh.celebs;
  return {
    celebs,
    source: fresh.anyReal ? "sec-edgar" : "sample",
    updatedAt: new Date().toISOString(),
    detail: fillDetail(rows, fresh.detail)
  };
}

/* 懒定时：服务器有访问时，过期名人（ARK / Form4 每日、13F 每周）在后台自动刷新，
   不阻塞当前响应；同一天只触发一次检查 */
let refreshRunning = false;
async function scheduleBackgroundRefresh(rows: CelebRow[], cache: CacheShape) {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const stale = rows.some((r) => r.sourceKind !== "none" && !isCelebFresh(r, cache));
    if (!stale && cache.scheduledDate === today) return;
    await refreshCelebs(rows, cache);
  } catch {
    /* 后台刷新失败不影响展示 */
  } finally {
    refreshRunning = false;
  }
}

/* 名人增删改后更新缓存中的对应条目，让前台立即生效（不整表删除重拉） */
export function patchCelebCache(id: string): void {
  const row = listCelebRows(false).find((r) => r.id === id);
  const cache = readCache();
  if (!cache) return;
  const base = row ? rowToCeleb(row) : null;
  const idx = cache.celebs.findIndex((c) => c.id === id);
  if (base) {
    if (idx >= 0) {
      cache.celebs[idx] = { ...cache.celebs[idx], ...base, holdings: base.holdings };
    } else {
      cache.celebs.push(base);
    }
    cache.fetchedAt[id] = new Date().toISOString(); // 编辑后短时间内不被后台 SEC 覆盖
    cache.detail[id] = row?.sourceKind === "none" ? "公开披露 · 示例数据" : row?.sourceLabel || "SEC EDGAR";
  } else if (idx >= 0) {
    cache.celebs.splice(idx, 1);
    delete cache.detail[id];
    delete cache.fetchedAt[id];
    delete cache.lastAccession[id];
  }
  cache.at = Date.now();
  writeCache(cache);
}

export function sortCelebCache(): void {
  const cache = readCache();
  if (!cache) return;
  const rows = listCelebRows(false);
  cache.celebs.sort((a, b) => rows.findIndex((r) => r.id === a.id) - rows.findIndex((r) => r.id === b.id));
  writeCache(cache);
}

/* ---------- 收益日线（近 5 年，每天一个点，CSV 持久化到附件名人文件夹） ---------- */

const ATTACH_ROOT = path.join(process.cwd(), "data", "attachments");
const DAYS_5Y = 5 * 365 + 1; // 1826 天
const CSV_VERSION = 3; // 曲线生成逻辑变更时 +1，触发旧 CSV 重新生成

function dailyDates(days: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/* 固定种子伪随机（同一名人每次生成一致） */
function seededRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/* 名人 id → 稳定种子（不同名人的噪声细节不同，刷新一致） */
function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return h / 9973;
}

/* 高斯波峰（t 附近 center / width 的峰：计划回撤、末段冲高、波动放大区域） */
function gaussPeak(t: number, center: number, width: number): number {
  return Math.exp(-Math.pow((t - center) / width, 2));
}

/* Catmull-Rom 样条：通过关键控制点，输出 60 个月相对终点（0→1）的目标路径 */
function targetPath5y(points: number[][]): number[] {
  const months = 60;
  const n = points.length;
  const out: number[] = [];
  for (let i = 0; i < months; i += 1) {
    const t = i / (months - 1);
    if (t <= points[0][0]) {
      out.push(points[0][1]);
      continue;
    }
    if (t >= points[n - 1][0]) {
      out.push(points[n - 1][1]);
      continue;
    }
    let seg = 0;
    while (seg < n - 2 && points[seg + 1][0] < t) seg += 1;
    const p0 = points[Math.max(0, seg - 1)];
    const p1 = points[seg];
    const p2 = points[seg + 1];
    const p3 = points[Math.min(n - 1, seg + 2)];
    const tt = (t - p1[0]) / (p2[0] - p1[0] || 1);
    const tt2 = tt * tt;
    const tt3 = tt2 * tt;
    out.push(
      0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * tt +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * tt2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * tt3)
    );
  }
  return out;
}

/* 组合收益 5 年目标路径：早期回撤（抗跌）+ 近3年 / 近1年锚点 + 后期深 V + 末段冲高回落（参考富途形态） */
function comboPath5y(r3: number, r1: number): number[] {
  return targetPath5y([
    [0, 0],
    [0.22, 0.07],
    [0.3, 0.1], // 2022 年回撤低点（组合相对抗跌）
    [0.42, r3], // 近 3 年锚点（3 年收益 = y3）
    [0.55, r3 + (r1 - r3) * 0.36],
    [0.7, r3 + (r1 - r3) * 0.68],
    [0.8, r1], // 近 1 年锚点（1 年收益 = y1）
    [0.87, r1 - 0.1], // 后期深 V 低点（1 年窗口中部，回撤约 -7.6%）
    [0.93, r1 + (1 - r1) * 0.45],
    [0.985, 1.09], // 末段冲高（高于终点约 +9%）
    [1, 1]
  ]);
}

/* 对比基准 5 年目标路径：早期深度回撤（比组合深）、后期深 V 更深、末段冲高略低 */
function benchPath5y(r1: number): number[] {
  return targetPath5y([
    [0, 0],
    [0.22, 0.06],
    [0.3, -0.3], // 2022 年熊市深度回撤（基准指数）
    [0.42, r1 * 0.6],
    [0.55, r1 * 0.76],
    [0.7, r1 * 0.92],
    [0.8, r1], // 近 1 年锚点（1 年收益 = 基准 y1）
    [0.87, r1 - 0.2], // 后期深 V（比组合深）
    [0.93, r1 + (1 - r1) * 0.48],
    [0.985, 1.07],
    [1, 1]
  ]);
}

/* 日线合成：目标路径（含 3 年 / 1 年锚点与富途形态）+ 锚点处归零的有界噪声（涨跌有致、数值与顶部一致） */
function synthDaily5y(
  targetMonthly: number[],
  end: number,
  opts: { persist: number; sigma: number; pull: number; volBoost: number; seed: number },
  anchors: [number, number][] = []
): number[] {
  const days = DAYS_5Y;
  const targetRel = monthlyToDaily(targetMonthly, days);
  const target = targetRel.map((v) => v * (end || 0));
  const rnd = seededRand(opts.seed);
  const dev: number[] = [];
  let cur = 0;
  let prevNoise = 0;
  for (let i = 0; i < days; i += 1) {
    const t = i / (days - 1);
    const volScale =
      1 +
      opts.volBoost *
        (2.0 * gaussPeak(t, 0.3, 0.12) + 2.5 * gaussPeak(t, 0.87, 0.07) + 2.8 * gaussPeak(t, 0.97, 0.035));
    const sigma = opts.sigma * volScale;
    const noise = opts.persist * prevNoise + (rnd() - 0.5) * 2 * sigma;
    cur = cur * (1 - opts.pull) + noise; // 围绕 0 的均值回归噪声（不会长漂移）
    prevNoise = noise;
    dev.push(cur);
  }
  // 锚点处偏差归零（分段线性扣除），区间内噪声形状保留
  const zeroPts = [0, ...anchors.map((a) => a[0]), days - 1];
  for (let s = 0; s < zeroPts.length - 1; s += 1) {
    const i0 = zeroPts[s];
    const i1 = zeroPts[s + 1];
    const d0 = dev[i0];
    const d1 = dev[i1];
    const span = i1 - i0 || 1;
    for (let i = i0; i <= i1; i += 1) {
      const t = (i - i0) / span;
      dev[i] -= d0 + (d1 - d0) * t;
    }
  }
  // 目标路径微调：锚点处精确等于指定值（如 y5-y1），线性过渡到相邻锚点，不产生折角
  const adj: [number, number][] = [[0, 0]];
  anchors.forEach(([idx, val]) => adj.push([idx, val - target[idx]]));
  adj.push([days - 1, 0]);
  for (let s = 0; s < adj.length - 1; s += 1) {
    const i0 = adj[s][0];
    const off0 = adj[s][1];
    const i1 = adj[s + 1][0];
    const off1 = adj[s + 1][1];
    const span = i1 - i0 || 1;
    // 跳过上一段已处理的起点，避免锚点处偏移被重复叠加
    for (let i = s === 0 ? i0 : i0 + 1; i <= i1; i += 1) {
      const t = (i - i0) / span;
      target[i] += off0 + (off1 - off0) * t;
    }
  }
  return target.map((v, i) => v + dev[i] * (end || 0));
}

/* 月序列 → 每日线性插值 */
function monthlyToDaily(monthly: number[], days: number): number[] {
  const n = monthly.length;
  if (n < 2) return Array.from({ length: days }, () => monthly[0] || 0);
  const out: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const pos = (i / (days - 1)) * (n - 1);
    const a = Math.floor(pos);
    const b = Math.min(n - 1, a + 1);
    const t = pos - a;
    out.push(monthly[a] + (monthly[b] - monthly[a]) * t);
  }
  return out;
}

export interface ReturnsDaily {
  dates: string[];
  values: number[];
  benchmarks: { code: string; name: string; values: number[] }[];
}

export function getReturnsDaily(celebId: string): ReturnsDaily {
  const rows = listCelebRows(false);
  const row = rows.find((r) => r.id === celebId);
  const fallback = CELEBS.find((c) => c.id === celebId);
  const ret = (row?.returns ?? fallback?.returns ?? {
    y1: 0,
    y3: 0,
    y5: 0,
    spxY1: 0,
    points: [0],
    spxPoints: []
  }) as Celeb["returns"];
  const benches =
    Array.isArray(ret.benchmarks) && ret.benchmarks.length > 0
      ? ret.benchmarks
      : Array.isArray(ret.spxPoints) && ret.spxPoints.length > 1
        ? [{ code: "SPX", name: "标普500指数", y1: ret.spxY1 ?? 0, points: ret.spxPoints }]
        : [];

  // 名人附件文件夹：优先复用现有（如「沃伦巴菲特」），否则按 name 新建
  const name = row?.name ?? fallback?.name ?? celebId;
  let folder = name;
  try {
    if (existsSync(ATTACH_ROOT)) {
      const dirs = readdirSync(ATTACH_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      folder = dirs.find((d) => d.includes(name)) ?? name;
    }
  } catch {
    folder = name;
  }
  const csvDir = path.join(ATTACH_ROOT, folder, "收益");
  const csvFile = path.join(csvDir, "收益日线.csv");

  const parse = (text: string): ReturnsDaily => {
    const lines = text.trim().split("\n").filter((l) => l && !l.startsWith("#"));
    const dates: string[] = [];
    const values: number[] = [];
    const benchValues: number[][] = benches.map(() => []);
    lines.slice(1).forEach((ln) => {
      const cols = ln.split(",");
      if (cols.length < 2) return;
      dates.push(cols[0]);
      values.push(Number(cols[1]) || 0);
      benches.forEach((b, bi) => {
        const v = Number(cols[2 + bi]);
        benchValues[bi].push(Number.isFinite(v) ? v : 0);
      });
    });
    return { dates, values, benchmarks: benches.map((b, i) => ({ code: b.code, name: b.name, values: benchValues[i] })) };
  };

  try {
    if (existsSync(csvFile)) {
      const text = readFileSync(csvFile, "utf8");
      const lines = text.trim().split("\n");
      if (lines.length > 30 && lines[0]?.trim() === `#v${CSV_VERSION}`) return parse(text);
    }
  } catch {
    /* 重新生成 */
  }

  const dates = dailyDates(DAYS_5Y);
  const y5 = ret.y5 || 0;
  const y3 = ret.y3 ?? y5 * 0.65;
  const y1 = ret.y1 ?? y5 * 0.35;
  const r3 = Math.max(0, (y5 - y3) / Math.max(0.01, y5));
  const r1 = Math.max(0, (y5 - y1) / Math.max(0.01, y5));
  const combo = synthDaily5y(comboPath5y(r3, r1), y5, {
    persist: 0.85,
    sigma: 0.0022,
    pull: 0.3,
    volBoost: 0.55,
    seed: 0.37 + seedFromId(celebId) * 0.5
  }, [
    [Math.round(0.42 * (DAYS_5Y - 1)), y5 - y3], // 近 3 年锚点（3 年收益 = y3）
    [Math.round(0.8 * (DAYS_5Y - 1)) + 1, y5 - y1] // 近 1 年锚点（1 年收益 = y1，与前端 slice(-365) 起点一致）
  ]);
  const benchSeries = benches.map((b) => {
    // 基准 5 年终点：基准近 1 年 + 组合 5 年/1 年差额 × 1.03（参考富途：标普 5 年 ≈ 组合 5 年，略低；负收益也安全）
    const end = (b.y1 || 0) + Math.max(0, y5 - y1) * 1.03;
    const r1b = (end - (b.y1 || 0)) / Math.max(0.01, end);
    return {
      code: b.code,
      name: b.name,
      values: synthDaily5y(benchPath5y(r1b), end, {
        persist: 0.87,
        sigma: 0.003,
        pull: 0.28,
        volBoost: 0.8,
        seed: 1.23 + seedFromId(celebId) * 0.5
      }, [[Math.round(0.8 * (DAYS_5Y - 1)) + 1, end - (b.y1 || 0)]]) // 近 1 年锚点（1 年收益 = 基准 y1）
    };
  });
  try {
    mkdirSync(csvDir, { recursive: true });
    const header = ["date", "组合收益", ...benches.map((b) => b.name)].join(",");
    const rows = dates.map((d, i) =>
      [d, combo[i].toFixed(3), ...benchSeries.map((s) => s.values[i].toFixed(3))].join(",")
    );
    writeFileSync(csvFile, [`#v${CSV_VERSION}`, header, ...rows].join("\n"), "utf8");
  } catch {
    /* 写盘失败不影响返回 */
  }
  return { dates, values: combo, benchmarks: benchSeries };
}
