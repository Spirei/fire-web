import type { QuoteItem } from "./quotes";

/** Public market data only: share overlapping lookups, never user records or caller IDs. */
export class MarketDataPool<T> {
  private readonly cached = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T | undefined>>();

  constructor(private readonly ttl: number, private readonly cacheable: (value: T) => boolean = () => true) {}

  async fetch(items: QuoteItem[], namespace: string, load: (items: QuoteItem[]) => Promise<Record<string, T>>): Promise<Record<string, T>> {
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
      // Register each symbol before starting I/O, so partially overlapping batches join it.
      const task = Promise.resolve().then(() => load(missing.map(({ item }) => item)));
      for (const { key, item } of missing) {
        const read = task.then(data => {
          const value = data[item.id];
          if (value !== undefined && this.cacheable(value)) this.cached.set(key, { value, at: Date.now() });
          this.pending.delete(key);
          return value;
        }, error => {
          this.pending.delete(key);
          throw error;
        });
        this.pending.set(key, read);
        reads.set(key, read);
      }
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
    for (const [key, entry] of this.cached) if (now - entry.at >= this.ttl) this.cached.delete(key);
    while (this.cached.size > 1024) this.cached.delete(this.cached.keys().next().value!);
  }
}
