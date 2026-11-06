function parseLine(line: string): { symbol: string; fields: string[] } | null {
  const match = /v_([^=]+)="([^"]*)"/.exec(line);
  if (!match) return null;
  return { symbol: match[1], fields: match[2].split("~") };
}

export async function fetchBatch(symbols: string[], signal?: AbortSignal, publish?: (symbol: string, quote: Quote) => void): Promise<Map<string, Quote>> {
  if (symbols.length === 0) return new Map();
  const base = getSiteSettings().quoteApiUrl || DEFAULT_QUOTE_URL;
  const map = new Map<string, Quote>();
  // 腾讯行情接口当前每次请求只返回第一条（批量已失效），改为并发逐条请求
  const CONCURRENCY = 6;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, async () => {
    while (next < symbols.length && !signal?.aborted) {
      const symbol = symbols[next++];
      try {
        const res = await fetch(base + symbol, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
        });
        if (!res.ok) continue;
        const buffer = await res.arrayBuffer();
        let text: string;
        try {
          text = new TextDecoder("gbk").decode(buffer);
        } catch {
          text = new TextDecoder("utf-8").decode(buffer);
        }
        const parsed = parseLine(text);
        if (!parsed || parsed.fields.length < 35) continue;
        const f = parsed.fields;
        const price = Number(f[3]);
        if (!price) continue;
        // 无效代码会被行情源模糊匹配成某个“幽灵”证券：成交量/成交额、涨跌、涨跌幅全为 0，且时间停留在很久以前。
        // 这类占位行情不是真实股价，直接丢弃，避免“不存在股票却显示股价/市场图标/旧日期”。
        const change = Number(f[31]) || 0;
        const changePct = Number(f[32]) || 0;
        const volume = Number(f[36]) || 0;
        const amount = Number(f[37]) || 0;
        // 日股 / 韩股字段口径与美港 A 不完全一致，有现价就收下，避免 0 成交量被当成幽灵行情丢掉。
        const jpKr = parsed.symbol.startsWith("jp") || parsed.symbol.startsWith("kr");
        if (!jpKr && volume === 0 && change === 0 && changePct === 0 && amount === 0) continue;
        const quote: Quote = {
          name: f[1] || "",
          price,
          change,
          changePct,
          open: Number(f[5]) || price,
          high: Number(f[33]) || price,
          low: Number(f[34]) || price,
          time: f[30] || "",
          prevClose: Number(f[4]) || price - (Number(f[31]) || 0),
          session: "REGULAR",
          volume,
          amount,
          pe: Number(f[39]) || undefined,
          // Generic PE is the established f39 contract; do not label it TTM.
          detailMetrics: /^(us|hk|sh|sz|bj)/.test(parsed.symbol) ? {
            currency: parsed.symbol.startsWith("us") ? "USD" : parsed.symbol.startsWith("hk") ? "HKD" : "CNY",
            time: f[30] || "", source: "tencent",
            pe: Number.isFinite(Number(f[39])) && Number(f[39]) !== 0 ? Number(f[39]) : undefined
          } : undefined,
          turnover: Number(f[38]) || 0,
          amplitude: Number(f[43]) || 0,
          marketCap: Number(f[44]) > 0 ? Number(f[44]) * 1e8 : undefined,
          epsTtm: Number(f[47]) || undefined,
          weekHigh: Number(f[48]) || undefined,
          weekLow: Number(f[49]) || undefined,
          pb: Number(f[51]) || undefined,
          dividendYieldTtm: Number(f[52]) || undefined,
          volumeRatio: Number(f[55]) || undefined,
          totalShares: Number(f[62]) || undefined,
          floatShares: Number(f[63]) || undefined,
          staticPe: Number(f[65]) || undefined,
          dividendTtm: Number(f[66]) || undefined,
          averagePrice: Number(f[67]) || undefined
        };
        map.set(parsed.symbol, quote);
        publish?.(parsed.symbol, quote);
      } catch {
        /* 单条失败不影响其他 */
      }
    }
  }));
  return map;
}
