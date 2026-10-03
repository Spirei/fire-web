import type { QuoteItem } from "./quotes";

interface Policy { intervalMs: number; phase: string }
interface Candidate { item: QuoteItem; requestedAt: number; phase: string }
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
    this.idleMs = options.idleMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.hotMs = options.hotMs ?? 90_000;
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
    const unique = new Map(items.map(item => {
      const id = JSON.stringify([item.market, item.code]);
      return [id, { market: item.market, code: item.code, id }];
    }));
    for (const [key, item] of unique) {
      const policy = this.options.policy(item, now);
      if (!item.code || !policy) continue;
      const active = this.active.get(key);
      if (active) {
        const sleeping = now - active.requestedAt >= this.hotMs;
        active.requestedAt = now;
        if (sleeping || active.phase !== policy.phase) active.nextRefresh = now;
        continue;
      }
      const candidate = this.candidates.get(key);
      if (candidate && this.active.size >= this.capacity) {
        // Make room for current demand before dormant securities. Never evict an in-flight hot reader.
        const dormant = [...this.active].filter(([, entry]) => now - entry.requestedAt >= this.hotMs)
          .sort((a, b) => a[1].requestedAt - b[1].requestedAt)[0];
        if (dormant) this.active.delete(dormant[0]);
      }
      if (candidate && this.active.size < this.capacity) {
        this.candidates.delete(key);
        this.active.set(key, { item, requestedAt: now, nextRefresh: now, phase: candidate.phase, failures: 0 });
      } else {
        this.candidates.delete(key);
        this.candidates.set(key, { item, requestedAt: now, phase: policy.phase });
      }
    }
    while (this.candidates.size > this.candidateCapacity) this.candidates.delete(this.candidates.keys().next().value!);
    this.arm();
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
      refreshing: this.jobs.size, timerArmed: this.timer !== undefined };
  }

  dispose() { this.stopped = true; this.reset(""); }

  private reset(namespace: string) {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.namespace = namespace;
    this.candidates.clear(); this.active.clear(); this.jobs.clear();
  }

  private expire(now: number) {
    for (const [key, entry] of this.candidates) if (now - entry.requestedAt >= this.repeatMs) this.candidates.delete(key);
    for (const [key, entry] of this.active) if (now - entry.requestedAt >= this.idleMs) this.active.delete(key);
  }

  private arm() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    const now = this.now();
    let due = Infinity;
    for (const entry of this.candidates.values()) due = Math.min(due, entry.requestedAt + this.repeatMs);
    for (const entry of this.active.values()) {
      due = Math.min(due, entry.requestedAt + this.idleMs);
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
