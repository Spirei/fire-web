import type { QuoteItem } from "./quotes";

/** Public market data only: share overlapping lookups, never user records or caller IDs. */
export class MarketDataPool<T> {
  private readonly cached = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T | undefined>>();

  constructor(private readonly ttl: number, private readonly cacheable: (value: T) => boolean = () => true) {}

  /** A completed public quote may be used briefly while a new lookup is pending. */
  peek(items: QuoteItem[], namespace: string, maxAge = this.ttl): Record<string, T> {
    const result: Record<string, T> = Object.create(null);
    for (const item of items) {
      const entry = this.cached.get(JSON.stringify([namespace, item.market, item.code]));
      if (entry && Date.now() - entry.at < maxAge) result[item.id] = structuredClone(entry.value);
    }
    return result;
  }

  async fetch(items: QuoteItem[], namespace: string, load: (items: QuoteItem[], publish: (item: QuoteItem, value: T) => void) => Promise<Record<string, T>>): Promise<Record<string, T>> {
    const now = Date.now();
    const unique = new Map<string, QuoteItem>();
    const keys = items.map(item => {
      const key = JSON.stringify([namespace, item.market, item.code]);
      unique.set(key, { ...item, id: JSON.stringify([item.market, item.code]) });
      return key;
    });
    const reads = new Map<string, Promise<T | undefined>>();
    const missing: Array<{ key: string; item: QuoteItem }> = [];
    for (const [key, item] of unique) {
      const cached = this.cached.get(key);
      if (cached && now - cached.at < this.ttl) reads.set(key, Promise.resolve(cached.value));
      else if (this.pending.has(key)) reads.set(key, this.pending.get(key)!);
      else missing.push({ key, item });
    }
    if (missing.length) {
      // Register separate promises before I/O. Completed symbols release joined readers
      // immediately, even when another market/symbol in the original batch is slow.
      const finish = new Map<string, (value: T | undefined, error?: unknown) => void>();
      for (const { key, item } of missing) {
        const read = new Promise<T | undefined>((resolve, reject) => {
          finish.set(item.id, (value, error) => {
            finish.delete(item.id);
            if (value !== undefined && this.cacheable(value)) this.cached.set(key, { value: structuredClone(value), at: Date.now() });
            this.pending.delete(key);
            if (error !== undefined) reject(error);
            else resolve(value);
          });
        });
        this.pending.set(key, read);
        reads.set(key, read);
      }
      void Promise.resolve().then(() => load(missing.map(({ item }) => item), (item, value) => finish.get(item.id)?.(value))).then(data => {
        for (const { item } of missing) finish.get(item.id)?.(data[item.id]);
      }, error => {
        for (const { item } of missing) finish.get(item.id)?.(undefined, error);
      });
    }
    const resolved = new Map(await Promise.all([...reads].map(async ([key, read]) => [key, await read] as const)));
    this.trim();
    const result: Record<string, T> = Object.create(null);
    items.forEach((item, index) => {
      const value = resolved.get(keys[index]);
      // Consumers may enrich quotes or transform points; shared values stay immutable.
      if (value !== undefined) result[item.id] = structuredClone(value);
    });
    return result;
  }
  private trim() {
    const now = Date.now();
    // Keep a bounded one-minute fallback; normal fetch still honors its shorter TTL.
    for (const [key, entry] of this.cached) if (now - entry.at >= Math.max(this.ttl, 60_000)) this.cached.delete(key);
    while (this.cached.size > 1024) this.cached.delete(this.cached.keys().next().value!);
  }
}
