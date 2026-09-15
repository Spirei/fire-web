import { fetchQuotes, type QuoteItem } from "./quotes";
import { readTradingSquareSnapshot } from "./tradingSquareSnapshot";
import type { StockRecord } from "./types";

export type AssistantLiveDataOptions = {
  /** 是否带上「我的持仓 / 自选」的实时行情（对应助手的账户数据范围设置）。 */
  includeAccount: boolean;
  /**
   * 是否真的去抓行情。默认跟随 includeAccount；提问与行情无关时传 false，
   * 避免每个问题都多等一次行情源往返（抓不到也不影响回答）。
   */
  includeQuotes?: boolean;
  /** 行情抓取的硬超时，避免拖慢首字。 */
  quoteTimeoutMs?: number;
};

function clean(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 站内实时数据快照：把「交易广场最新动态 + 我的持仓/自选行情」整理成可直接引用的文字块。
 *
 * 这两类数据本来就在站内实时获取（交易广场读服务端缓存、行情走富途/腾讯/Yahoo），
 * 模型自己没有联网能力，所以由服务端取好、连同时效一起交给它——助手因此可以回答
 * 「最近有什么大新闻」「特斯拉现在什么价」，而不必再一律回答"我无法联网"。
 * 任何一步失败都只是少一段数据，不影响对话；抓取时间会一并标注，便于模型说明数据新鲜度。
 */
export async function buildAssistantLiveData(records: StockRecord[], options: AssistantLiveDataOptions): Promise<string[]> {
  const lines: string[] = [];

  try {
    const posts = readTradingSquareSnapshot(6);
    if (posts.length) {
      lines.push("交易广场最近动态（站内实时抓取的公开内容，作者 · 时间 · 摘要）：");
      posts.forEach((post, index) => {
        const author = post.author === "trump" ? "特朗普" : "段永平";
        const time = String(post.date || "").slice(5, 16).replace("T", " ");
        const summary = clean(post.textZh || post.text || "", 80);
        if (!summary) return;
        lines.push(`  ${index + 1}) [${author} · ${time}] ${summary}`);
      });
    }
  } catch {
    /* 读不到就少这一段，下面的话术会说明站内暂无可引用数据 */
  }

  if ((options.includeQuotes ?? options.includeAccount) && records.length) {
    const items: QuoteItem[] = records
      .filter((record) => record.code && record.market)
      .slice(0, 12)
      .map((record) => ({ id: `${record.market.toUpperCase()}:${record.code.toUpperCase()}`, market: record.market.toUpperCase(), code: record.code.toUpperCase() }));
    if (items.length) {
      const timeoutMs = options.quoteTimeoutMs ?? 2500;
      try {
        const quotes = await Promise.race([
          fetchQuotes(items).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);
        if (quotes) {
          const rows = items.flatMap((item) => {
            const quote = quotes[item.id];
            if (!quote || !Number.isFinite(quote.price)) return [];
            const record = records.find((entry) => entry.code.toUpperCase() === item.code && entry.market.toUpperCase() === item.market);
            const name = record?.name || quote.name || item.code;
            const changePct = Number.isFinite(quote.changePct) ? ` ${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : "";
            return [`  ${name}(${item.code} · ${item.market}) 现价 ${quote.price}${changePct}`];
          });
          if (rows.length) lines.push(`我的持仓 / 自选行情（原币，未换算显示币种）：`, ...rows);
        }
      } catch {
        /* 行情源不可用时跳过，不阻塞对话 */
      }
    }
  }

  return lines;
}
