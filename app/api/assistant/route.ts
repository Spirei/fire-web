import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { listRecords } from "@/lib/store";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { marketMeta, type StockRecord } from "@/lib/types";
import { listWatchGroups } from "@/lib/watchGroupsStore";

type ChatMessage = { role: "user" | "assistant"; content: string };
type PageContext = { page?: string; label?: string; symbol?: string; filter?: string };
type AssistantAction =
  | { type: "navigate"; label: string; path: string }
  | { type: "create_group"; label: string; name: string; createdAt: string }
  | { type: "assign_group"; label: string; groupId: string; groupName: string; recordIds: string[]; symbols: string[]; previous: Array<{ id: string; groupId: string }>; createdAt: string }
  | { type: "trade"; label: string; recordId: string; code: string; name: string; market: string; side: "buy" | "sell"; qty: number; price: number; fees: number; createdAt: string };

const PAGE_LABELS: Record<string, string> = {
  holdings: "账户资产", assets: "资产分析", pnl: "资产总盈亏", fire: "FIRE",
  watchlist: "自选股", global: "全球经济", trading: "交易广场", earnings: "财报日历",
  celebs: "名人持仓", cards: "卡面库", library: "素材库", settings: "设置"
};

function compactRecords(records: StockRecord[]) {
  const holdings = records.filter((item) => Number(item.qty) > 0);
  const byMarket = new Map<string, { count: number; holdings: number }>();
  records.forEach((item) => {
    const key = String(item.market || "OTHER").toUpperCase();
    const row = byMarket.get(key) || { count: 0, holdings: 0 };
    row.count += 1;
    if (Number(item.qty) > 0) row.holdings += 1;
    byMarket.set(key, row);
  });
  const incompleteAll = records.filter((item) => !item.code || !item.name || item.price === "");
  const incomplete = incompleteAll.slice(0, 12);
  const staleBefore = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const staleAll = records.filter((item) => {
    const updatedAt = Date.parse(item.updatedAt || "");
    return !Number.isFinite(updatedAt) || updatedAt < staleBefore;
  });
  const stale = staleAll.slice(0, 12);
  const codeCounts = new Map<string, number>();
  records.forEach((item) => codeCounts.set(`${item.market}:${item.code}`.toUpperCase(), (codeCounts.get(`${item.market}:${item.code}`.toUpperCase()) || 0) + 1));
  const duplicates = [...codeCounts].filter(([, count]) => count > 1).map(([key]) => key).slice(0, 12);
  const positions = holdings
    .map((item) => ({
      code: item.code,
      name: item.name,
      market: marketMeta(item.market).label,
      quantity: Number(item.qty),
      cost: item.cost === "" ? null : Number(item.cost),
      savedPrice: item.price === "" ? null : Number(item.price),
      broker: item.group || "未分组"
    }))
    .sort((a, b) => Math.abs((b.savedPrice || 0) * b.quantity) - Math.abs((a.savedPrice || 0) * a.quantity))
    .slice(0, 30);
  const marketConcentration = [...byMarket.keys()].map((market) => {
    const rows = holdings.filter((item) => item.market.toUpperCase() === market).map((item) => ({ code: item.code, value: Math.abs(Number(item.qty) * Number(item.price || item.cost || 0)) })).sort((a, b) => b.value - a.value);
    const total = rows.reduce((sum, item) => sum + item.value, 0);
    return { market: marketMeta(market).label, top: rows.slice(0, 5).map((item) => ({ code: item.code, share: total > 0 ? Number((item.value / total * 100).toFixed(1)) : 0 })) };
  });
  return {
    counts: { all: records.length, holdings: holdings.length, watchOnly: records.length - holdings.length },
    markets: [...byMarket].map(([market, value]) => ({ market, label: marketMeta(market).label, ...value })),
    positions,
    diagnostics: {
      incompleteCount: incompleteAll.length,
      incomplete: incomplete.map((item) => `${item.market}:${item.code || "无代码"} ${item.name || "无名称"}`),
      staleCount: staleAll.length,
      stale: stale.map((item) => `${item.market}:${item.code}`),
      duplicates
    },
    concentrationByMarket: marketConcentration
  };
}

function fallbackAnswer(question: string, records: StockRecord[], context: PageContext) {
  const summary = compactRecords(records);
  const page = context.label || PAGE_LABELS[context.page || ""] || "当前页面";
  if (/诊断|异常|问题|缺失|空白/.test(question)) {
    const findings = [];
    if (summary.diagnostics.incompleteCount) findings.push(`${summary.diagnostics.incompleteCount} 条基础资料不完整（${summary.diagnostics.incomplete.join("、")}）`);
    if (summary.diagnostics.duplicates.length) findings.push(`发现同市场重复代码：${summary.diagnostics.duplicates.join("、")}`);
    if (summary.diagnostics.staleCount) findings.push(`${summary.diagnostics.staleCount} 条记录超过 7 天未更新`);
    return findings.length
      ? `我检查了 ${summary.counts.all} 只股票，发现：${findings.join("；")}。下一步建议先刷新行情，再处理仍缺失或重复的记录。`
      : `我检查了 ${summary.counts.all} 只股票，代码、名称、保存价格、重复代码和更新时间没有发现明显异常。若页面仍显示空白，下一步应检查该页面的接口状态与浏览器控制台。`;
  }
  if (/集中|风险|结构|复盘|贡献/.test(question)) {
    const detail = summary.concentrationByMarket.map((market) => `${market.market}前列为 ${market.top.map((item) => `${item.code} ${item.share}%`).join("、")}`).join("；");
    return `按各市场保存价格分别计算（未跨币种相加）：${detail || "暂无可计算持仓"}。优先检查单一标的占同市场超过 30%、同一主题高度相关，以及杠杆 ETF 的日内复利损耗。下一步可指定市场或代码继续分析。`;
  }
  if (/持仓|仓位|股票|自选|概览|多少/.test(question)) {
    const markets = summary.markets.map((item) => `${item.label} ${item.holdings} 只持仓/${item.count} 只记录`).join("，");
    return `当前共有 ${summary.counts.all} 只股票，其中 ${summary.counts.holdings} 只有持仓，${summary.counts.watchOnly} 只仅在自选。按市场看：${markets || "暂无记录"}。你现在位于「${page}」，可以继续问某个市场、股票或分组。`;
  }
  return `我已读取「${page}」和你的账户股票数据。当前有 ${summary.counts.holdings} 只持仓、${summary.counts.watchOnly} 只仅自选。大模型尚未配置，因此目前可用账户概览与数据诊断；在设置的大模型区域填入 API Key 后，可以进行更自由的追问和归因分析。`;
}

const NAV_TARGETS: Array<[RegExp, string, string]> = [
  [/资产总盈亏/, "资产总盈亏", "/asset-pnl-analysis"], [/资产分析/, "资产分析", "/asset-analysis"],
  [/我的持仓|账户资产/, "账户资产", "/holdings"], [/自选股|行情板/, "自选股", "/watchlist"],
  [/FIRE/i, "FIRE", "/fire"], [/财报日历/, "财报日历", "/earnings"], [/全球经济/, "全球经济", "/global"],
  [/交易广场/, "交易广场", "/trading"], [/卡面库/, "卡面库", "/cards"], [/素材库/, "素材库", "/library"]
];
const MARKET_FILTERS: Array<[RegExp, string, string]> = [[/美股/, "美股", "us"], [/港股/, "港股", "hk"], [/A股|a股/, "A股", "cn"]];

function recordForToken(records: StockRecord[], token: string) {
  const value = token.trim().toUpperCase();
  const qualified = records.find((item) => {
    const market = item.market.toUpperCase();
    const code = item.code.toUpperCase();
    return value === `${market}.${code}` || value === `${market}:${code}` || value === `${market}-${code}`;
  });
  if (qualified) return qualified;
  const matches = records.filter((item) => value === item.code.toUpperCase());
  return matches.length === 1 ? matches[0] : undefined;
}

function parseAction(question: string, records: StockRecord[], userId: string): { answer: string; action?: AssistantAction } | null {
  const createdAt = new Date().toISOString();
  const trade = question.match(/(?:记录|录入|记一笔|我)?\s*(买入|卖出)\s*([A-Za-z0-9.:-]{1,20})\s*(\d+(?:\.\d+)?)\s*(?:股|只|份)?\s*(?:，|,|@|以|价格|单价|每股)?\s*(\d+(?:\.\d+)?)/i);
  if (trade) {
    const record = recordForToken(records, trade[2]);
    const qty = Number(trade[3]), price = Number(trade[4]);
    const sameCode = records.filter((item) => item.code.toUpperCase() === trade[2].toUpperCase());
    if (!record && sameCode.length > 1) {
      return { answer: `代码 ${trade[2].toUpperCase()} 在多个市场都有记录，请改用 ${sameCode.map((item) => `${item.market.toUpperCase()}:${item.code}`).join(" 或 ")} 明确标的。` };
    }
    if (!record) return null;
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) {
      return { answer: "数量和成交价必须是大于 0 的有效数字，请修改后重新输入。" };
    }
    const side = trade[1] === "买入" ? "buy" : "sell";
    return {
      answer: `已生成${trade[1]}预览。请核对股票、数量、价格和预计金额，确认后才会写入订单与持仓。`,
      action: { type: "trade", label: `确认${trade[1]}入账`, recordId: record.id, code: record.code, name: record.name, market: record.market.toUpperCase(), side, qty, price, fees: 0, createdAt }
    };
  }

  const create = question.match(/(?:创建|新建|添加)(?:一个|名为)?[“"']?(.{1,30}?)[”"']?(?:的)?(?:自选)?分组(?:吧|。|！|!)?$/);
  if (create) {
    const name = create[1].trim();
    return { answer: `已准备创建自选分组“${name}”。确认后才会保存，你也可以继续修改名称。`, action: { type: "create_group", label: "确认创建分组", name, createdAt } };
  }

  const assign = question.match(/(?:把|将)\s*([A-Za-z0-9.、,，\s:-]+?)\s*(?:移到|移动到|加入|放进)\s*[“"']?(.{1,30}?)[”"']?(?:分组)?(?:里|中|。|！|!)?$/i);
  if (assign) {
    const tokens = [...new Set(assign[1].split(/[、,，\s]+/).filter(Boolean))];
    const resolved = tokens.map((token) => ({ token, record: recordForToken(records, token) }));
    const unresolved = resolved.filter((item) => !item.record).map((item) => item.token.toUpperCase());
    if (unresolved.length) return { answer: `未能唯一确定 ${unresolved.join("、")}。如果不同市场有相同代码，请写成 US:代码、HK:代码或 CN:代码后重试。` };
    const selected = [...new Map(resolved.map((item) => item.record as StockRecord).map((item) => [item.id, item])).values()];
    const groupName = assign[2].trim().replace(/分组$/, "").trim();
    const group = listWatchGroups(userId).find((item) => item.kind === "custom" && item.name.toLowerCase() === groupName.toLowerCase());
    if (!group) return { answer: `没有找到自选分组“${groupName}”。请先创建该分组，或检查名称后重试。` };
    if (selected.length && group) return {
      answer: `已找到 ${selected.map((item) => item.code).join("、")} 和分组“${group.name}”。确认后会移动，并提供撤销。`,
      action: { type: "assign_group", label: `确认移入“${group.name}”`, groupId: group.id, groupName: group.name, recordIds: selected.map((item) => item.id), symbols: selected.map((item) => item.code), previous: selected.map((item) => ({ id: item.id, groupId: item.watchGroupId || "" })), createdAt }
    };
  }

  const asksToNavigate = /打开|前往|跳转|带我去|切到|只看|筛选/.test(question);
  if (asksToNavigate) {
    const market = MARKET_FILTERS.find(([pattern]) => pattern.test(question));
    if (market && /自选|行情板|只看|筛选/.test(question)) {
      return { answer: `可以，已准备打开自选股并筛选${market[1]}。`, action: { type: "navigate", label: `查看${market[1]}自选`, path: `/watchlist?filter=${market[2]}` } };
    }
    const target = NAV_TARGETS.find(([pattern]) => pattern.test(question));
    if (target) return { answer: `可以，已找到“${target[1]}”。`, action: { type: "navigate", label: `打开${target[1]}`, path: target[2] } };
  }
  return null;
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`assistant:${clientIp(request)}:${user.id}`, 24, 60_000) || !rateLimitGlobal("assistant", 240, 60_000)) {
    return NextResponse.json({ error: "提问过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null) as { messages?: ChatMessage[]; context?: PageContext } | null;
  const messages = (body?.messages || []).filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string").slice(-10);
  const question = messages.at(-1)?.content.trim().slice(0, 1200) || "";
  if (!question) return NextResponse.json({ error: "请输入问题" }, { status: 400 });

  const records = listRecords(user.id);
  const context = body?.context || {};
  const planned = parseAction(question, records, user.id);
  if (planned) return NextResponse.json({ ...planned, mode: "action" });
  const settings = getSiteSettings();
  const apiKey = (settings.llmApiKey || settings.deepseekApiKey || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
  const apiUrl = (settings.llmApiUrl || settings.deepseekApiUrl || "").trim();
  if (!apiKey || !apiUrl) return NextResponse.json({ answer: fallbackAnswer(question, records, context), mode: "local" });

  const pageLabel = context.label || PAGE_LABELS[context.page || ""] || "未知页面";
  const system = `你是 Fire 投资记实里的账户助手。用简体中文回答，先给结论，再给依据和下一步。只能依据给出的账户上下文，不得编造实时价格、收益或新闻；不同市场的原币金额不能直接相加。你可以做分析、筛选建议和数据诊断，但不能声称已经执行交易或修改数据。涉及买卖判断时说明关键变量和风险，不给绝对承诺。当前页面：${pageLabel}${context.symbol ? `；当前股票：${context.symbol}` : ""}${context.filter ? `；当前筛选：${context.filter}` : ""}。账户上下文：${JSON.stringify(compactRecords(records))}`;
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: settings.llmModel || settings.deepseekModel || "deepseek-chat",
        temperature: 0.2,
        messages: [{ role: "system", content: system }, ...messages.map((item) => ({ role: item.role, content: item.content.slice(0, 1200) }))]
      }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store"
    });
    const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    if (!response.ok) return NextResponse.json({ error: data?.error?.message || "大模型暂时不可用" }, { status: 502 });
    const answer = data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return NextResponse.json({ error: "大模型没有返回内容" }, { status: 502 });
    return NextResponse.json({ answer, mode: "llm" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.name === "TimeoutError" ? "回答超时，请重试" : "大模型连接失败" }, { status: 502 });
  }
}
