import type Database from "better-sqlite3";
import type { QuoteItem } from "./quotes";
import { publicQuoteItems, QUOTE_DEMAND_HOT_MS, QUOTE_DEMAND_IDLE_MS, QUOTE_USER_LIMIT, type PublicQuoteDemand } from "./quoteDemand";

interface Row { market: QuoteItem["market"]; code: string; last_requested_at: number; reads: number }
export class QuoteSubscriptionLimitError extends Error {
  readonly code = "QUOTE_SUBSCRIPTION_LIMIT";
}

/** Private user leases in SQLite; pool-facing results contain only public securities. */
export class QuoteSubscriptionsStore {
  constructor(private readonly db: Database.Database, private readonly options: {
    now?: () => number; idleMs?: number; userLimit?: number;
  } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private cutoff() { return this.now() - (this.options.idleMs ?? QUOTE_DEMAND_IDLE_MS); }
  private limit() { return this.options.userLimit ?? QUOTE_USER_LIMIT; }
  private item(row: Pick<Row, "market" | "code">): QuoteItem { return { market: row.market, code: row.code, id: JSON.stringify([row.market, row.code]) }; }
  private write<T>(operation: () => T): T {
    // Operational bookkeeping must not add a multi-second SQLite lock wait to quotes.
    const busyTimeout = this.db.pragma("busy_timeout", { simple: true }) as number;
    this.db.pragma("busy_timeout = 50");
    try { return this.db.transaction(operation).immediate(); }
    finally { this.db.pragma(`busy_timeout = ${busyTimeout}`); }
  }

  list(userId: string, market?: string) {
    const now = this.now();
    const rows = this.db.prepare(`SELECT market, code, last_requested_at, reads FROM quote_subscriptions
      WHERE user_id=? AND last_requested_at>? ${market ? "AND market=?" : ""} ORDER BY market, code`)
      .all(userId, this.cutoff(), ...(market ? [market] : [])) as Row[];
    return rows.map(row => ({ market: row.market, code: row.code, lastRequestedAt: row.last_requested_at,
      expiresAt: row.last_requested_at + (this.options.idleMs ?? QUOTE_DEMAND_IDLE_MS),
      state: now - row.last_requested_at < QUOTE_DEMAND_HOT_MS ? "hot" : "dormant" }));
  }

  touch(userId: string, items: QuoteItem[], explicit = false): PublicQuoteDemand[] {
    const normalized = publicQuoteItems(items);
    if (explicit && normalized.length > this.limit()) throw new QuoteSubscriptionLimitError();
    const selected = normalized.slice(0, this.limit());
    if (!selected.length) return [];
    return this.write(() => {
      const changed = [...this.pruneItems(), ...selected];
      const current = this.db.prepare("SELECT market, code FROM quote_subscriptions WHERE user_id=?").all(userId) as Row[];
      const keys = new Set(selected.map(item => item.id));
      const union = new Set([...current.map(row => this.item(row).id), ...keys]);
      const excess = Math.max(0, union.size - this.limit());
      if (explicit && excess) throw new QuoteSubscriptionLimitError();
      if (excess) {
        const old = this.db.prepare("SELECT market, code FROM quote_subscriptions WHERE user_id=? ORDER BY last_requested_at, market, code")
          .all(userId) as Row[];
        const remove = this.db.prepare("DELETE FROM quote_subscriptions WHERE user_id=? AND market=? AND code=?");
        for (const row of old.filter(row => !keys.has(this.item(row).id)).slice(0, excess)) {
          remove.run(userId, row.market, row.code); changed.push(this.item(row));
        }
      }
      const now = this.now();
      const write = this.db.prepare(`INSERT INTO quote_subscriptions(user_id,market,code,last_requested_at,reads) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,market,code) DO UPDATE SET last_requested_at=MAX(last_requested_at,excluded.last_requested_at),
          reads=CASE WHEN last_requested_at<=? THEN excluded.reads ELSE MIN(2,reads+1) END`);
      for (const item of selected) write.run(userId, item.market, item.code, now, explicit ? 2 : 1, this.cutoff());
      return this.aggregate(changed);
    });
  }

  remove(userId: string, items?: QuoteItem[]): PublicQuoteDemand[] {
    return this.write(() => {
      const old = this.db.prepare("SELECT market, code FROM quote_subscriptions WHERE user_id=?").all(userId) as Row[];
      const keys = items ? new Set(publicQuoteItems(items).map(item => item.id)) : undefined;
      const changed = old.filter(row => !keys || keys.has(this.item(row).id)).map(row => this.item(row));
      const remove = this.db.prepare("DELETE FROM quote_subscriptions WHERE user_id=? AND market=? AND code=?");
      for (const item of changed) remove.run(userId, item.market, item.code);
      return this.aggregate([...changed, ...this.pruneItems()]);
    });
  }

  prune(): PublicQuoteDemand[] {
    return this.write(() => this.aggregate(this.pruneItems()));
  }
  private pruneItems(): QuoteItem[] {
    const cutoff = this.cutoff();
    const old = this.db.prepare("SELECT DISTINCT market,code FROM quote_subscriptions WHERE last_requested_at<=?").all(cutoff) as Row[];
    if (old.length) this.db.prepare("DELETE FROM quote_subscriptions WHERE last_requested_at<=?").run(cutoff);
    return old.map(row => this.item(row));
  }
  nextExpiry(): number | undefined {
    const row = this.db.prepare("SELECT last_requested_at FROM quote_subscriptions ORDER BY last_requested_at LIMIT 1").get() as Row | undefined;
    return row ? row.last_requested_at + (this.options.idleMs ?? QUOTE_DEMAND_IDLE_MS) : undefined;
  }
  aggregate(items?: QuoteItem[]): PublicQuoteDemand[] {
    if (!items) {
      const rows = this.db.prepare(`SELECT market,code,MAX(last_requested_at) last_requested_at,MIN(2,SUM(reads)) reads
        FROM quote_subscriptions WHERE last_requested_at>? GROUP BY market,code ORDER BY last_requested_at DESC LIMIT 4096`)
        .all(this.cutoff()) as Row[];
      return rows.map(row => ({ item: this.item(row), requestedAt: row.last_requested_at, reads: row.reads }));
    }
    const unique = publicQuoteItems(items), result: PublicQuoteDemand[] = [];
    // Bound SQL parameters; indexes make each affected security independent of table size.
    for (let n = 0; n < unique.length; n += 100) {
      const batch = unique.slice(n, n + 100);
      const rows = this.db.prepare(`SELECT market,code,MAX(last_requested_at) last_requested_at,MIN(2,SUM(reads)) reads
        FROM quote_subscriptions WHERE last_requested_at>? AND (market,code) IN (${batch.map(() => "(?,?)").join(",")}) GROUP BY market,code`)
        .all(this.cutoff(), ...batch.flatMap(item => [item.market, item.code])) as Row[];
      const found = new Map(rows.map(row => [this.item(row).id, row]));
      for (const item of batch) {
        const row = found.get(item.id);
        result.push(row ? { item, requestedAt: row.last_requested_at, reads: row.reads } : { item });
      }
    }
    return result;
  }
}
