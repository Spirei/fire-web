import type { Quote, StockRecord } from "./types";
import { normalizeMarketCode } from "./marketCode";

type Item = Pick<StockRecord, "id" | "market" | "code">;
/** Asset views need held securities; watchlist sorting needs its complete list.
 * Both scopes use the same quote pool, source selection and observation DTOs. */
export function selectQuoteRecords(records: StockRecord[], view: string): StockRecord[] {
  return records.filter(record => view === "watchlist" || Number(record.qty) > 0);
}

export interface QuoteBatchResult { quotes: Record<string, Quote>; completed: Set<string>; retired?: Set<string> }

export function quoteInstrumentKey(item: Item): string {
  return JSON.stringify([item.id, item.market.toUpperCase(), normalizeMarketCode(item.market.toUpperCase(), item.code)]);
}

/** A withdrawn quote is missing even if this security loaded earlier. */
export function hasLoadedQuote(item: Item, quotes: Record<string, Quote>, loaded: Set<string>): boolean {
  const quote = quotes[item.id];
  return loaded.has(quoteInstrumentKey(item)) && !!quote && Number.isFinite(quote.price) && quote.price > 0;
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

/** 两个滚动批次；临时失败保留本批，身份或许可拒绝时撤下旧行情。 */
export async function readQuoteBatches(items: Item[], signal?: AbortSignal, options: { includeMarketCap?: boolean; ownerId?: string } = {}): Promise<QuoteBatchResult> {
  const result: QuoteBatchResult = { quotes: Object.create(null), completed: new Set(), retired: new Set() };
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
          method: "POST", headers: { "Content-Type": "application/json", ...(options.ownerId ? {"X-Alcor-Expected-Account":options.ownerId} : {}) }, cache: "no-store", signal: controller.signal,
          body: JSON.stringify({ items: batch, includeMarketCap: options.includeMarketCap === true })
        });
        if (!response.ok) {
          if ([401,403].includes(response.status)) for (const item of batch) { result.completed.add(item.id); result.retired!.add(item.id); }
          continue;
        }
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
    else if (result.retired?.has(item.id)) delete merged[item.id];
    else if (merged[item.id]) merged[item.id] = { ...merged[item.id], cached: true, displayStale: true };
  }
  return merged;
}
