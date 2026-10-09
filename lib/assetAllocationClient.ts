import { ALLOCATION_CATEGORIES, type AllocationAccount, type AllocationSnapshot } from "./assetAllocationTypes";
import { ALLOCATION_READ_TIMEOUT_MS, ALLOCATION_WRITE_TIMEOUT_MS } from "./assetAllocationContract";

export class AllocationClientError extends Error {
  constructor(message: string, public status = 0, public uncertain = false) { super(message); this.name = "AllocationClientError"; }
}

/** Editing a label or inclusion must not turn a live source into a fixed statement. */
export function allocationAmountMode(account: AllocationAccount | null, amount: number): "automatic" | "statement" {
  return account && account.kind !== "manual" && !account.reconciled && amount === account.amount ? "automatic" : "statement";
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const nullable = (value: unknown) => value === null || finite(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const category = (value: unknown) => ALLOCATION_CATEGORIES.includes(value as typeof ALLOCATION_CATEGORIES[number]);
const unique = (rows: Record<string, unknown>[]) => new Set(rows.map(row => row.id)).size === rows.length;

/** Reject partial/proxy responses before any amount or owner enters the UI. */
export function validAllocationSnapshot(value: unknown, currency: string, owner?: string): value is AllocationSnapshot {
  if (!object(value) || value.version !== 1 || typeof value.accountId !== "string" || !value.accountId || owner && value.accountId !== owner
    || value.currency !== currency || !date(value.observedAt) || typeof value.snapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotRevision)) return false;
  const { summary: s, bankSummary: b, quoteStatus: q } = value;
  if (!object(s) || ![s.totalAsset, s.totalDebt, s.netAsset, s.portfolioTotalAsset, s.difference].every(nullable)
    || !finite(s.knownAsset) || typeof s.complete !== "boolean" || !count(s.accountCount)
    || !object(b) || !count(b.count) || !count(b.includedCount) || Number(b.includedCount) > Number(b.count) || !nullable(b.value)
    || !object(q) || typeof q.pending !== "boolean" || !strings(q.cached) || !strings(q.missing)) return false;
  const { accounts, positions, categories, brokers, issues } = value;
  if (!Array.isArray(accounts) || !accounts.every(a => object(a) && typeof a.id === "string" && !!a.id
    && typeof a.name === "string" && ["broker", "bank", "fund", "ledger", "manual"].includes(String(a.kind)) && category(a.category)
    // Unknown/corrupt source currencies must remain visible with unavailable valuation.
    && typeof a.currency === "string" && (a.value === null || /^[A-Z]{3}$/.test(a.currency)) && [a.amount, a.value, a.holdings, a.cash].every(nullable)
    && strings(a.recordIds) && typeof a.icon === "string" && typeof a.source === "string" && (a.updatedAt === null || date(a.updatedAt))
    && typeof a.excluded === "boolean" && typeof a.reconciled === "boolean" && count(a.revision) && object(a.components)
    && Object.entries(a.components).every(([key, amount]) => category(key) && nullable(amount))) || !unique(accounts)
    || accounts.filter(a => !a.excluded).length !== s.accountCount) return false;
  if (!Array.isArray(categories) || categories.length !== ALLOCATION_CATEGORIES.length || !categories.every(c => object(c)
    && category(c.id) && typeof c.name === "string" && nullable(c.value) && nullable(c.weightPct)) || !unique(categories)) return false;
  if (!Array.isArray(positions) || !positions.every(p => object(p) && typeof p.id === "string" && typeof p.name === "string"
    && typeof p.code === "string" && (p.market === undefined || typeof p.market === "string" && !!p.market) && typeof p.currency === "string" && (p.brokerId === null || typeof p.brokerId === "string")
    && count(p.revision) && typeof p.accountId === "string") || !unique(positions)) return false;
  // A badge must describe the same positions that contribute to this account.
  const accountById = new Map(accounts.map(a => [a.id, a]));
  const positionById = new Map(positions.map(p => [p.id, p]));
  if (positions.some(p => !accountById.get(p.accountId)?.recordIds.includes(p.id))
    || accounts.some(a => new Set(a.recordIds).size !== a.recordIds.length
      || a.recordIds.some((id: string) => positionById.get(id)?.accountId !== a.id))) return false;
  return Array.isArray(brokers) && brokers.every(b => object(b) && typeof b.id === "string" && typeof b.name === "string" && typeof b.icon === "string") && unique(brokers)
    && Array.isArray(issues) && issues.every(i => object(i) && typeof i.code === "string" && strings(i.accountIds) && typeof i.message === "string");
}

/** The deadline bounds both headers and body, even when a fetch implementation ignores abort. */
async function bounded<T>(timeout: number, writing: boolean, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const cancel = () => { clearTimeout(timer); controller.abort(); rejectStop(new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  timer = setTimeout(() => { controller.abort(); rejectStop(new AllocationClientError(writing ? "保存超时，结果待确认，请重新读取" : "账户读取超时，请重试", 0, writing)); }, timeout);
  try { return await Promise.race([stopped, controller.signal.aborted ? stopped : run(controller.signal)]); }
  catch (error) {
    if (error instanceof AllocationClientError || error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AllocationClientError(writing ? "连接中断，保存结果待确认，请重新读取" : "账户暂时无法读取，请重试", 0, writing);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
async function envelope(response: Response, writing: boolean) {
  let body: unknown;
  try { body = await response.json(); } catch { throw new AllocationClientError(writing ? "保存结果无法确认，请重新读取" : "账户响应无效，请重试", response.status, writing && response.status >= 200 && response.status < 400 || writing && response.status >= 500); }
  if (!response.ok || !object(body) || body.code !== 0) {
    const message = object(body) && typeof body.message === "string" && body.message.length <= 200 && body.code !== 0 ? body.message : writing ? "保存失败，请重新读取" : "账户暂时无法读取，请重试";
    throw new AllocationClientError(message, response.status, writing && (response.status >= 500 || response.ok));
  }
  return body.data;
}
const tag = (snapshot: AllocationSnapshot) => `W/"${snapshot.snapshotRevision}"`;
const sameTag = (header: string | null, snapshot: AllocationSnapshot) => header?.replace(/^W\//, "") === tag(snapshot).slice(2);

export function readAllocation(currency: string, previous: AllocationSnapshot | null, signal?: AbortSignal) {
  const reusable = previous?.currency === currency ? previous : null;
  return bounded(ALLOCATION_READ_TIMEOUT_MS, false, signal, async signal => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (previous) headers["X-Allocation-User"] = previous.accountId;
    if (reusable) headers["If-None-Match"] = tag(reusable);
    const response = await fetch(`/api/asset-allocation?currency=${encodeURIComponent(currency)}`, { signal, headers, cache: "no-store", credentials: "same-origin" });
    const checkedAt = response.headers.get("X-Allocation-Observed-At");
    if (response.status === 304) {
      if (!reusable || !sameTag(response.headers.get("ETag"), reusable) || !date(checkedAt)) throw new AllocationClientError("账户响应无效，请重新读取");
      return { snapshot: reusable, checkedAt };
    }
    const snapshot = await envelope(response, false);
    if (previous && object(snapshot) && snapshot.accountId !== previous.accountId) throw new AllocationClientError("当前账号已切换，请重新读取", 409);
    if (!validAllocationSnapshot(snapshot, currency, previous?.accountId) || !sameTag(response.headers.get("ETag"), snapshot)
      || !date(checkedAt)) throw new AllocationClientError("账户响应无效，请重试");
    // Retain node identity on identical reads; checkedAt still records this successful check.
    return { snapshot: reusable?.snapshotRevision === snapshot.snapshotRevision ? reusable : snapshot, checkedAt };
  });
}

export function writeAllocation(method: "POST" | "PUT" | "DELETE", path: "/api/asset-allocation" | "/api/asset-allocation/assign", owner: string, body: Record<string, unknown>) {
  return bounded(ALLOCATION_WRITE_TIMEOUT_MS, true, undefined, async signal => {
    const response = await fetch(path, { method, signal, credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Allocation-User": owner }, body: JSON.stringify(body) });
    const result = await envelope(response, true);
    const records = body.records as { id: string }[] | undefined;
    const valid = object(result) && (path.endsWith("/assign") ? result.brokerId === body.brokerId && strings(result.recordIds)
      && records && result.recordIds.length === records.length && new Set(result.recordIds).size === records.length && records.every(r => (result.recordIds as string[]).includes(r.id))
      : result.id === (body.id ?? `manual:${body.requestId}`) && (method === "DELETE" ? result.restored === !String(body.id).startsWith("manual:") : result.revision === Number(body.revision) + 1));
    if (!valid) throw new AllocationClientError("保存结果无法确认，请重新读取", response.status, true);
    return result;
  });
}
