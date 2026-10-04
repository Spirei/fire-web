import type { QuoteItem } from "./quotes";
import { publicQuoteItems, QUOTE_DEMAND_HOT_MS, QUOTE_DEMAND_IDLE_MS, type PublicQuoteDemand } from "./quoteDemand";

interface Policy { intervalMs: number; phase: string }
interface Candidate {
  item: QuoteItem; requestedAt: number; phase: string;
  anonymousAt?: number; anonymousReads: number; subscribedAt?: number; subscribedReads: number;
}
interface Active extends Candidate { nextRefresh: number; failures: number }
interface Job { entries: Array<[string, Active]>; namespace: string }

/** Demand leases for public securities only. Background reads never renew a lease. */
export class ActiveQuotePool {
  private namespace = "";
  private readonly candidates = new Map<string, Candidate>();
  private readonly active = new Map<string, Active>();
  private readonly jobs = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly idleMs: number;
  private readonly hotMs: number;
  private readonly repeatMs: number;
  private readonly capacity: number;
  private readonly candidateCapacity: number;
  private readonly batchSize: number;

  constructor(private readonly options: {
    currentNamespace: () => string;
    policy: (item: QuoteItem, now: number) => Policy | undefined;
    refresh: (items: QuoteItem[], namespace: string) => Promise<Record<string, unknown>>;
    now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
    idleMs?: number; hotMs?: number; repeatMs?: number; capacity?: number; candidateCapacity?: number; batchSize?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.idleMs = options.idleMs ?? QUOTE_DEMAND_IDLE_MS;
    this.hotMs = options.hotMs ?? QUOTE_DEMAND_HOT_MS;
    this.repeatMs = options.repeatMs ?? this.idleMs;
    this.capacity = options.capacity ?? 256;
    this.candidateCapacity = options.candidateCapacity ?? 1024;
    this.batchSize = options.batchSize ?? 20;
  }

  observe(items: QuoteItem[], namespace: string) {
    if (this.stopped) return;
    if (namespace !== this.namespace) this.reset(namespace);
    const now = this.now();
    this.expire(now);
    for (const item of publicQuoteItems(items)) {
      const key = item.id;
      const policy = this.options.policy(item, now);
      if (!item.code || !policy) continue;
      const entry = this.active.get(key) ?? this.candidates.get(key) ?? this.create(item, now);
      const previousAt = entry.requestedAt;
      entry.anonymousAt = now; entry.anonymousReads = Math.min(2, entry.anonymousReads + 1);
      this.admit(key, entry, previousAt, now);
    }
    this.trimCandidates();
    this.arm();
  }

  /** Merge aggregate user demand; no user identifier crosses into the public pool. */
  reconcileSubscriptions(changes: PublicQuoteDemand[], namespace: string, replace = false) {
    if (this.stopped) return;
    if (namespace !== this.namespace) this.reset(namespace);
    const now = this.now(); this.expire(now);
    const selected = new Map<string, PublicQuoteDemand>();
    for (const change of changes) {
      const item = publicQuoteItems([change.item])[0];
      if (item) selected.set(item.id, { ...change, item });
    }
    if (replace) for (const [key, entry] of [...this.candidates, ...this.active]) {
      if (entry.subscribedAt !== undefined && !selected.has(key)) selected.set(key, { item: entry.item });
    }
    for (const change of selected.values()) {
      const item = publicQuoteItems([change.item])[0];
      if (!item || !this.options.policy(item, now)) continue;
      const at = change.requestedAt;
      const entry = this.active.get(item.id) ?? this.candidates.get(item.id) ?? this.create(item, at ?? now);
      const previousAt = entry.requestedAt;
      entry.subscribedAt = Number.isFinite(at) && at! > now - this.idleMs ? Math.min(now, at!) : undefined;
      entry.subscribedReads = entry.subscribedAt === undefined ? 0 : Math.min(2, Math.max(1, change.reads ?? 1));
      this.admit(item.id, entry, previousAt, now);
    }
    this.trimCandidates(); this.arm();
  }

  private create(item: QuoteItem, at: number): Candidate {
    return { item, requestedAt: at, phase: (this.options.policy(item, at) ?? this.options.policy(item, this.now()))!.phase,
      anonymousReads: 0, subscribedReads: 0 };
  }

  private admit(key: string, entry: Candidate, previousAt: number, now: number) {
    entry.requestedAt = Math.max(entry.anonymousAt ?? -Infinity, entry.subscribedAt ?? -Infinity);
    if (!Number.isFinite(entry.requestedAt)) { this.active.delete(key); this.candidates.delete(key); return; }
    const ready = entry.anonymousReads + entry.subscribedReads >= 2;
    const active = this.active.get(key);
    if (active && ready) {
      if (now - previousAt >= this.hotMs || active.phase !== this.options.policy(entry.item, now)!.phase) active.nextRefresh = now;
      return;
    }
    if (active) this.active.delete(key);
    if (ready) {
      const marketEntries = [...this.active].filter(([, current]) => current.item.market === entry.item.market);
      if (marketEntries.length >= this.capacity) {
        const dormant = marketEntries.filter(([, current]) => now - current.requestedAt >= this.hotMs)
          .sort((a, b) => a[1].requestedAt - b[1].requestedAt)[0];
        if (dormant && entry.requestedAt >= dormant[1].requestedAt) this.active.delete(dormant[0]);
        else { this.candidates.set(key, entry); return; }
      }
      this.candidates.delete(key);
      this.active.set(key, { ...entry, nextRefresh: now, failures: 0 });
    } else this.candidates.set(key, entry);
  }

  private trimCandidates() {
    if (this.candidates.size <= this.candidateCapacity) return;
    const ordered = [...this.candidates].sort((a, b) => a[1].requestedAt - b[1].requestedAt);
    for (const [key] of ordered.slice(0, this.candidates.size - this.candidateCapacity)) this.candidates.delete(key);
  }

  /** A snapshot is usable only within this market's interval and the same session. */
  cacheAge(item: QuoteItem, namespace: string): number | undefined {
    if (this.stopped || namespace !== this.namespace) return undefined;
    const entry = this.active.get(JSON.stringify([item.market, item.code]));
    const now = this.now(), policy = this.options.policy(item, now);
    if (!entry || now - entry.requestedAt >= this.hotMs || !policy || entry.phase !== policy.phase) return undefined;
    return Math.min(60_000, policy.intervalMs + 5_000);
  }

  refreshing(items: QuoteItem[], namespace: string): boolean {
    if (namespace !== this.namespace) return false;
    const keys = new Set(items.map(item => JSON.stringify([item.market, item.code])));
    const now = this.now();
    return [...this.jobs.values()].some(job => job.namespace === namespace && job.entries.some(([key]) => keys.has(key))) ||
      [...keys].some(key => {
        const entry = this.active.get(key);
        return entry !== undefined && now - entry.requestedAt < this.hotMs && entry.nextRefresh <= now;
      });
  }

  stats() {
    const now = this.now();
    const hot = [...this.active.values()].filter(entry => now - entry.requestedAt < this.hotMs).length;
    return { active: this.active.size, hot, dormant: this.active.size - hot, candidates: this.candidates.size,
      refreshing: this.jobs.size, timerArmed: this.timer !== undefined,
      markets: Object.fromEntries([...new Set([...this.active.values()].map(entry => entry.item.market))]
        .map(market => [market, [...this.active.values()].filter(entry => entry.item.market === market).length])) };
  }

  dispose() { this.stopped = true; this.reset(""); }

  private reset(namespace: string) {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.namespace = namespace;
    this.candidates.clear(); this.active.clear(); this.jobs.clear();
  }

  private expire(now: number) {
    for (const [map, anonymousMs] of [[this.candidates, this.repeatMs], [this.active, this.idleMs]] as const) {
      for (const [key, entry] of map) {
        if (entry.anonymousAt !== undefined && now - entry.anonymousAt >= anonymousMs) { entry.anonymousAt = undefined; entry.anonymousReads = 0; }
        if (entry.subscribedAt !== undefined && now - entry.subscribedAt >= this.idleMs) { entry.subscribedAt = undefined; entry.subscribedReads = 0; }
        entry.requestedAt = Math.max(entry.anonymousAt ?? -Infinity, entry.subscribedAt ?? -Infinity);
        if (!Number.isFinite(entry.requestedAt)) map.delete(key);
        else if (map === this.active && entry.anonymousReads + entry.subscribedReads < 2) {
          this.active.delete(key); this.candidates.set(key, entry);
        }
      }
    }
  }

  private arm() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    const now = this.now();
    let due = Infinity;
    for (const entry of this.candidates.values()) {
      if (entry.anonymousAt !== undefined) due = Math.min(due, entry.anonymousAt + this.repeatMs);
      if (entry.subscribedAt !== undefined) due = Math.min(due, entry.subscribedAt + this.idleMs);
    }
    for (const entry of this.active.values()) {
      if (entry.anonymousAt !== undefined) due = Math.min(due, entry.anonymousAt + this.idleMs);
      if (entry.subscribedAt !== undefined) due = Math.min(due, entry.subscribedAt + this.idleMs);
      if (now - entry.requestedAt < this.hotMs) {
        due = Math.min(due, entry.requestedAt + this.hotMs);
        if (!this.jobs.has(entry.item.market)) due = Math.min(due, entry.nextRefresh);
      }
    }
    if (!Number.isFinite(due)) return;
    this.timer = this.setTimer(() => { this.timer = undefined; this.tick(); }, Math.max(0, due - this.now()));
    this.timer.unref?.();
  }

  private tick() {
    if (this.stopped) return;
    let namespace: string;
    try { namespace = this.options.currentNamespace(); }
    catch { this.reset(this.namespace); return; }
    if (namespace !== this.namespace) { this.reset(namespace); return; }
    const now = this.now();
    this.expire(now);
    const markets = new Map<string, Array<[string, Active]>>();
    for (const pair of this.active) {
      const entry = pair[1], policy = this.options.policy(entry.item, now);
      if (!policy) { this.active.delete(pair[0]); continue; }
      if (now - entry.requestedAt >= this.hotMs) continue;
      if (policy.phase !== entry.phase) entry.nextRefresh = now;
      if (entry.nextRefresh > now || this.jobs.has(entry.item.market)) continue;
      markets.set(entry.item.market, [...(markets.get(entry.item.market) || []), pair]);
    }
    for (const [market, due] of markets) {
      const entries = due.sort((a, b) => a[1].nextRefresh - b[1].nextRefresh).slice(0, this.batchSize);
      const job: Job = { entries, namespace: this.namespace };
      const phases = new Map(entries.map(([key, entry]) => [key, this.options.policy(entry.item, now)!.phase]));
      this.jobs.set(market, job);
      void Promise.resolve().then(() => this.options.refresh(entries.map(([, entry]) => entry.item), job.namespace)).then(result => {
        this.finish(job, phases, result);
      }, () => this.finish(job, phases, {})).finally(() => {
        if (this.jobs.get(market) === job) this.jobs.delete(market);
        this.expire(this.now()); this.arm();
      }).catch(() => { if (job.namespace === this.namespace) this.reset(this.namespace); });
    }
    this.arm();
  }

  private finish(job: Job, phases: Map<string, string>, result: Record<string, unknown>) {
    if (this.stopped || job.namespace !== this.namespace) return;
    const now = this.now();
    for (const [key, entry] of job.entries) {
      // A late result cannot recreate a released entry or modify a newer lease.
      if (this.active.get(key) !== entry || now - entry.requestedAt >= this.idleMs) continue;
      const policy = this.options.policy(entry.item, now);
      if (!policy) continue;
      entry.failures = result[entry.item.id] === undefined ? Math.min(6, entry.failures + 1) : 0;
      entry.phase = phases.get(key)!;
      const interval = entry.failures ? Math.max(policy.intervalMs, Math.min(60_000, 5_000 * 2 ** entry.failures)) : policy.intervalMs;
      entry.nextRefresh = entry.phase === policy.phase ? now + interval : now;
    }
  }
}
