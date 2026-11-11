import type { Quote, StockRecord } from "./types";
import { normalizeMarketCode } from "./marketCode";

type Item = Pick<StockRecord, "id" | "market" | "code">;
export interface QuoteBatchResult { quotes: Record<string, Quote>; completed: Set<string> }

export function quoteInstrumentKey(item: Item): string {
  return JSON.stringify([item.id, item.market.toUpperCase(), normalizeMarketCode(item.market.toUpperCase(), item.code)]);
}

/** 首帧快照也必须匹配证券；同一记录换代码后不能恢复原证券价格。 */
export function restoreQuoteSnapshot(quotes: Record<string, Quote>, instruments: Record<string, string> | undefined, current: Item[]): Record<string, Quote> {
  const restored: Record<string, Quote> = Object.create(null);
  for (const item of current) {
    const quote = quotes[item.id];
    if (instruments?.[item.id] === quoteInstrumentKey(item) && quote && Number.isFinite(quote.price) && quote.price > 0) restored[item.id] = quote;
  }
  return restored;
}

/** 两个滚动批次；失败只影响本批，不能抹掉其他批次或失败批的旧行情。 */
export async function readQuoteBatches(items: Item[], signal?: AbortSignal, options: { includeMarketCap?: boolean } = {}): Promise<QuoteBatchResult> {
  const result: QuoteBatchResult = { quotes: Object.create(null), completed: new Set() };
  // Select a source per market; a mixed batch must not force US and HK/CN
  // securities onto one provider. Keep at most two requests in flight.
  const markets = new Map<string, Item[]>();
  for (const item of items) {
    const rows = markets.get(item.market) ?? [];
    rows.push(item); markets.set(item.market, rows);
  }
  const batches = [...markets.values()].flatMap(rows => Array.from({length: Math.ceil(rows.length / 100)}, (_, index) => rows.slice(index * 100, index * 100 + 100)));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const batch = batches[next++];
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const deadline = setTimeout(cancel, 30_000);
      try {
        const response = await fetch("/api/quotes", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: controller.signal,
          body: JSON.stringify({ items: batch, includeMarketCap: options.includeMarketCap === true })
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (!data?.quotes || typeof data.quotes !== "object" || Array.isArray(data.quotes)) continue;
        for (const item of batch) {
          result.completed.add(item.id);
          const quote = data.quotes[item.id];
          if (quote && Number.isFinite(quote.price) && quote.price > 0) result.quotes[item.id] = quote;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}

/** 在途期间记录可能换证券或删除；只接收仍属于当前证券的结果。 */
export function applyQuoteBatches(previous: Record<string, Quote>, result: QuoteBatchResult, requested: Item[], current: Item[]) {
  const byID = new Map(current.map(item => [item.id, item]));
  const merged: Record<string, Quote> = Object.assign(Object.create(null), previous);
  for (const item of requested) {
    const latest = byID.get(item.id);
    if (!latest || quoteInstrumentKey(latest) !== quoteInstrumentKey(item)) {
      delete merged[item.id];
      continue;
    }
    if (!result.completed.has(item.id)) continue;
    if (result.quotes[item.id]) merged[item.id] = result.quotes[item.id];
    else delete merged[item.id];
  }
  return merged;
}
