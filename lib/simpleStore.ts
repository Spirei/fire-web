import { getDb } from "./db";

export type SimpleItem = {
  id: string;
  name: string;
  cur: string;
  amount: number;
  date: string;
  owner?: string;
};

export type SimpleHist = { d: string; v: number; inn?: number; out?: number };

export type SimpleInvest = {
  id: string;
  name: string;
  cur: string;
  amount: number;
  bucket: string;
  market?: string;
  group?: string;
  owner?: string;
  inAmt: number;
  outAmt: number;
  updated: string;
  expected?: number;
  flowAdjusted?: boolean;
  hist: SimpleHist[];
};

export type SimpleSnap = {
  at: string;
  assets: number;
  debt: number;
  cash: number;
  fixed: number;
  inv: number;
  rec: number;
};

export type SimpleLog = {
  at: string;
  cat: string;
  id: string;
  name: string;
  amount: number;
  cur: string;
};

export type SimpleMember = { id: string; name: string; show?: boolean };

export type SimpleState = {
  hide: boolean;
  excludeFixed: boolean;
  displayCur: string;
  fx: Record<string, number>;
  reminder: number;
  expected: number;
  cash: SimpleItem[];
  fixed: SimpleItem[];
  receivable: SimpleItem[];
  debt: SimpleItem[];
  invest: SimpleInvest[];
  cashflow: { stable: number; flex: number; income: number };
  snaps: SimpleSnap[];
  logs: SimpleLog[];
  members: SimpleMember[];
};

export const EMPTY_SIMPLE: SimpleState = {
  hide: false,
  excludeFixed: false,
  displayCur: "CNY",
  fx: { CNY: 1, HKD: 0.92, USD: 7.18 },
  reminder: 0,
  expected: 8,
  cash: [],
  fixed: [],
  receivable: [],
  debt: [],
  invest: [],
  cashflow: { stable: 0, flex: 0, income: 0 },
  snaps: [],
  logs: [],
  members: [{ id: "me", name: "我" }]
};

function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

export function normalizeSimple(raw: unknown): SimpleState {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fxIn = parsed.fx && typeof parsed.fx === "object" ? (parsed.fx as Record<string, number>) : {};
  return {
    ...EMPTY_SIMPLE,
    ...parsed,
    hide: Boolean(parsed.hide),
    excludeFixed: Boolean(parsed.excludeFixed),
    displayCur: typeof parsed.displayCur === "string" ? parsed.displayCur : "CNY",
    reminder: Number(parsed.reminder) || 0,
    expected: Number.isFinite(Number(parsed.expected)) ? Number(parsed.expected) : 8,
    fx: { ...EMPTY_SIMPLE.fx, ...fxIn },
    cashflow: { ...EMPTY_SIMPLE.cashflow, ...((parsed.cashflow as object) || {}) },
    cash: asArray(parsed.cash, []),
    fixed: asArray(parsed.fixed, []),
    receivable: asArray(parsed.receivable, []),
    debt: asArray(parsed.debt, []),
    invest: asArray(parsed.invest, []),
    snaps: asArray(parsed.snaps, []),
    logs: asArray(parsed.logs, []),
    members: asArray(parsed.members, []).length ? asArray(parsed.members, []) : [{ id: "me", name: "我" }]
  };
}

export function getSimpleLedger(userId: string): SimpleState {
  try {
    const row = getDb().prepare("SELECT simple FROM user_settings WHERE user_id = ?").get(userId) as { simple?: string } | undefined;
    if (!row?.simple) return { ...EMPTY_SIMPLE };
    return normalizeSimple(JSON.parse(row.simple));
  } catch {
    return { ...EMPTY_SIMPLE };
  }
}

export function setSimpleLedger(userId: string, state: SimpleState) {
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, fire, simple) VALUES (?, '{}', ?)
       ON CONFLICT(user_id) DO UPDATE SET simple = excluded.simple`
    )
    .run(userId, JSON.stringify(normalizeSimple(state)));
}
