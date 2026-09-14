import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { listRecords } from "@/lib/store";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { marketMeta, type StockRecord } from "@/lib/types";

type ChatMessage = { role: "user" | "assistant"; content: string };
type PageContext = { page?: string; label?: string; symbol?: string; filter?: string };

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
  const incomplete = records.filter((item) => !item.code || !item.name || item.price === "").slice(0, 12);
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
  return {
    counts: { all: records.length, holdings: holdings.length, watchOnly: records.length - holdings.length },
    markets: [...byMarket].map(([market, value]) => ({ market, label: marketMeta(market).label, ...value })),
    positions,
    diagnostics: {
      incompleteCount: incomplete.length,
      incomplete: incomplete.map((item) => `${item.market}:${item.code || "无代码"} ${item.name || "无名称"}`)
    }
  };
}

function fallbackAnswer(question: string, records: StockRecord[], context: PageContext) {
  const summary = compactRecords(records);
  const page = context.label || PAGE_LABELS[context.page || ""] || "当前页面";
  if (/诊断|异常|问题|缺失|空白/.test(question)) {
    return summary.diagnostics.incompleteCount
      ? `我检查了 ${summary.counts.all} 只股票，发现 ${summary.diagnostics.incompleteCount} 条基础资料不完整：${summary.diagnostics.incomplete.join("、")}。建议先补齐代码、名称或价格，再检查行情源。`
      : `我检查了 ${summary.counts.all} 只股票，代码、名称和保存价格没有发现明显缺项。若页面仍显示空白，下一步应检查该页面的接口状态、行情时间和浏览器控制台。`;
  }
  if (/持仓|仓位|股票|自选|概览|多少/.test(question)) {
    const markets = summary.markets.map((item) => `${item.label} ${item.holdings} 只持仓/${item.count} 只记录`).join("，");
    return `当前共有 ${summary.counts.all} 只股票，其中 ${summary.counts.holdings} 只有持仓，${summary.counts.watchOnly} 只仅在自选。按市场看：${markets || "暂无记录"}。你现在位于「${page}」，可以继续问某个市场、股票或分组。`;
  }
  return `我已读取「${page}」和你的账户股票数据。当前有 ${summary.counts.holdings} 只持仓、${summary.counts.watchOnly} 只仅自选。大模型尚未配置，因此目前可用账户概览与数据诊断；在设置的大模型区域填入 API Key 后，可以进行更自由的追问和归因分析。`;
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
