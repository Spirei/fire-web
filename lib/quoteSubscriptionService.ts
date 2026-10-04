import type { QuoteItem } from "./quotes";
import type { PublicQuoteDemand } from "./quoteDemand";
import type { QuoteSubscriptionsStore } from "./quoteSubscriptionsStore";

/** Private persistence lifecycle. Public target receives aggregates, never user identities. */
export class QuoteSubscriptionService {
  private namespace?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private callbacks: {
    store: () => QuoteSubscriptionsStore;
    namespace: () => string;
    sync: (changes: PublicQuoteDemand[], replace?: boolean) => void;
  }, private readonly timing: {
    now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  } = {}) {}
  configure(callbacks: typeof this.callbacks) { this.callbacks = callbacks; }
  private now() { return (this.timing.now ?? Date.now)(); }
  private clear() {
    if (this.timer !== undefined) (this.timing.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }
  private initialize() {
    if (this.disposed) throw new Error("Quote subscription service is stopped");
    const namespace = this.callbacks.namespace();
    if (namespace !== this.namespace) {
      const store = this.callbacks.store(); store.prune();
      this.callbacks.sync(store.aggregate(), true); this.namespace = namespace;
      this.arm();
    }
  }
  observe(userId: string, items: QuoteItem[]) { this.change(() => this.callbacks.store().touch(userId, items)); }
  subscribe(userId: string, items: QuoteItem[]) { this.change(() => this.callbacks.store().touch(userId, items, true)); }
  remove(userId: string, items?: QuoteItem[]) { this.change(() => this.callbacks.store().remove(userId, items)); }
  list(userId: string, market?: string) { this.initialize(); return this.callbacks.store().list(userId, market); }
  private change(operation: () => PublicQuoteDemand[]) {
    this.initialize(); this.callbacks.sync(operation()); this.arm();
  }
  private arm(retryMs?: number) {
    this.clear(); if (this.disposed) return;
    const at = retryMs === undefined ? this.callbacks.store().nextExpiry() : this.now() + retryMs;
    if (at === undefined) return;
    this.timer = (this.timing.setTimer ?? setTimeout)(() => {
      this.timer = undefined;
      try {
        this.initialize(); this.callbacks.sync(this.callbacks.store().prune()); this.arm();
      } catch { this.arm(60_000); }
    }, Math.max(0, at - this.now()));
    this.timer.unref?.();
  }
  dispose() { this.disposed = true; this.clear(); }
}
