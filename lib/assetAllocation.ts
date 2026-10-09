import { createHash } from "node:crypto";
import { getSiteSettings } from "./settings";
import { getDb } from "./db";
import { listRecords } from "./store";
import { readAccountCash } from "./accountCashStore";
import { cardCashAccounts } from "./cardLibrary";
import { getSimpleLedger } from "./simpleStore";
import { ACCOUNT_MARKET_CURRENCY, accountHoldingPrice, convertAccountAmount, reconcileAccountCash } from "./accountCash";
import { buildOverview } from "./overview";
import { allocationRevisions, allocationRows } from "./assetAllocationStore";
import { ALLOCATION_CATEGORIES, ALLOCATION_LABELS, type AllocationAccount, type AllocationSnapshot } from "./assetAllocationTypes";
import type { Quote } from "./types";

const finite = (n: number): number | null => Number.isFinite(n) ? n : null;
const round = (n: number | null) => n === null ? null : +n.toFixed(2);
const stable = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 20);
/** Semantic read version; observation time is not a change to the recorded assets. */
export function allocationSnapshotRevision(snapshot: Omit<AllocationSnapshot, "snapshotRevision"> & { snapshotRevision?: string }) {
  const { observedAt: _observedAt, snapshotRevision: _revision, ...representation } = snapshot;
  return createHash("sha256").update(JSON.stringify(representation)).digest("hex");
}

/** Read-through sources and statement overrides, with each source contributing exactly once. */
export function buildAssetAllocation(userId: string, rates: Record<string, number>, quotes: Record<string, Quote>, currency: string, includeEmptyBanks = false): AllocationSnapshot {
  const records = listRecords(userId), cash = readAccountCash(userId), overview = buildOverview(records, rates, quotes, currency, cash);
  const accounts: AllocationAccount[] = [], issues: AllocationSnapshot["issues"] = [];
  const revisions = allocationRevisions(userId);
  const groups = getSiteSettings().groups;
  const icons = new Map((getDb().prepare("SELECT code,url FROM assets WHERE type='broker'").all() as { code: string; url: string }[]).map(a => [a.code.toLowerCase(), a.url]));
  const brokers = groups.map(g => ({ id: g.id, name: g.name, icon: icons.get(g.id.toLowerCase()) || "" }));
  const positions: AllocationSnapshot["positions"] = [];
  const nativeHoldings: Record<string, number> = {};
  const add = (data: Pick<AllocationAccount, "id" | "name" | "kind" | "category" | "currency" | "amount" | "source"> & Partial<AllocationAccount>) => {
    const amount = data.amount, value = amount === null ? null : finite(convertAccountAmount(amount, data.currency, rates, currency));
    const account: AllocationAccount = { holdings: null, cash: null, recordIds: [], icon: "", updatedAt: null, excluded: false, reconciled: false, revision: revisions.get(data.id) ?? 0, components: { [data.category]: value }, ...data, value };
    accounts.push(account); return account;
  };
  for (const r of records) {
    const qty = Number(r.qty); if (!Number.isFinite(qty) || qty <= 0) continue;
    const amount = qty * accountHoldingPrice(r, quotes), cur = ACCOUNT_MARKET_CURRENCY[r.market] || "UNKNOWN";
    nativeHoldings[r.market] = (nativeHoldings[r.market] ?? 0) + amount;
    const group = groups.find(g => g.name === r.group || g.alias && g.alias === r.group);
    const id = `broker:${group?.id || stable(r.group || "ungrouped")}:${cur}`;
    let account = accounts.find(a => a.id === id);
    if (!account) account = add({ id, name: group?.name || r.group || "未归属持仓", kind: "broker", category: "securities", currency: cur, amount: 0, source: "/records", icon: group ? icons.get(group.id.toLowerCase()) || "" : "" });
    positions.push({ id: r.id, name: r.name, code: r.code, currency: cur, brokerId: group?.id ?? null, revision: r.revision ?? 0, accountId: id });
    account.amount = (account.amount ?? 0) + amount; account.recordIds.push(r.id);
    account.updatedAt = !account.updatedAt || r.updatedAt > account.updatedAt ? r.updatedAt : account.updatedAt;
    account.holdings = account.amount;
  }
  // Shared card projection excludes credit limits and unheld cards; no wallet secrets are exposed.
  for (const card of cardCashAccounts(userId, true, true)) add({ id: `bank:${stable(card.id)}`, name: card.name, kind: "bank", category: "cash", currency: card.currency, amount: finite(card.amount), source: "/cards", updatedAt: card.updatedAt || null });
  const balances = reconcileAccountCash(cash.balances, cash.cardCash, cash.investmentEquities, nativeHoldings);
  for (const [cur, balance] of Object.entries(balances)) {
    const bank = cash.cardCash[cur] ?? 0, amount = balance - bank;
    if (amount === 0) continue;
    add({ id: `fund:${cur}`, name: `待归属现金 · ${cur}`, kind: "fund", category: "cash", currency: cur, amount: finite(amount), source: "/api/v1/funds" });
  }
  if (!cash.sourceComplete) issues.push({ code: "source_unavailable", accountIds: [], message: "资金账本不完整" });
  try {
    const stored = getDb().prepare("SELECT simple FROM user_settings WHERE user_id=?").get(userId) as { simple?: string } | undefined;
    const raw = stored?.simple ? JSON.parse(stored.simple) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || ["cash", "fixed", "receivable", "debt", "invest"].some(k => raw[k] !== undefined && !Array.isArray(raw[k]))) throw new Error("Invalid allocation ledger");
    const ledger = getSimpleLedger(userId, true);
    for (const [key, category] of [["cash", "cash"], ["fixed", "fixed"], ["receivable", "receivable"], ["debt", "debt"], ["invest", "investment"]] as const) {
      for (const item of ledger[key]) {
        const valid = item && typeof item.id === "string" && typeof item.cur === "string" && typeof item.amount === "number" && Number.isFinite(item.amount) && (category !== "debt" || item.amount >= 0);
        if (!valid) { issues.push({ code: "ledger_item_invalid", accountIds: [], message: "简化账本有无法核算的条目" }); continue; }
        const id = `ledger:${key}:${stable(item.id)}`;
        if (accounts.some(a => a.id === id)) { issues.push({ code: "ledger_item_invalid", accountIds: [id], message: "简化账本存在重复账户标识" }); continue; }
        if (key === "invest" && "market" in item && item.market) continue; // Linked equities are already in reconciled cash.
        add({ id, name: item.name || ALLOCATION_LABELS[category], kind: "ledger", category, currency: item.cur.toUpperCase(), amount: item.amount, source: "/simple-app" });
      }
    }
  } catch { issues.push({ code: "ledger_unavailable", accountIds: [], message: "简化账本暂时无法读取" }); }
  for (const row of allocationRows(userId)) {
    let a = accounts.find(a => a.id === row.source_id);
    if (!a) {
      a = add({ id: row.source_id, name: row.name, kind: "manual", category: row.category, currency: row.currency, amount: row.amount, source: "manual" });
      if (!row.source_id.startsWith("manual:")) {
        a.excluded = true;
        issues.push({ code: "source_removed", accountIds: [a.id], message: `${row.name}的关联来源已移除，核对记录不再计入` });
      }
    }
    Object.assign(a, { name: row.name, excluded: a.excluded || !!row.excluded, revision: row.revision });
    if (row.amount_mode === "statement") Object.assign(a, { amount: row.amount, currency: row.currency, category: row.category, updatedAt: row.updated_at, reconciled: true });
  }
  // Resolve statements first: a recorded nonzero card balance counts, an empty/unrecorded card does not.
  // Mutation validation can still inspect every held source, including a just-cleared balance.
  if (!includeEmptyBanks) for (let i = accounts.length - 1; i >= 0; i--) {
    const a = accounts[i]; if (a.kind === "bank" && (a.amount === 0 || a.amount === null && a.updatedAt === null)) accounts.splice(i, 1);
  }
  for (const a of accounts) {
    a.value = a.amount === null ? null : finite(convertAccountAmount(a.amount, a.currency, rates, currency));
    if (a.kind === "broker") {
      a.cash = a.reconciled && a.amount !== null && a.holdings !== null ? a.amount - a.holdings : null;
      const holdings = a.holdings === null ? null : finite(convertAccountAmount(a.holdings, a.currency, rates, currency));
      a.components = { securities: holdings, ...(a.cash !== null ? { cash: finite(convertAccountAmount(a.cash, a.currency, rates, currency)) } : {}) };
    } else a.components = { [a.category]: a.value };
    if (!a.excluded && a.value === null) issues.push({ code: "value_unavailable", accountIds: [a.id], message: a.amount === null ? `${a.name}${a.kind === "bank" && a.updatedAt ? "余额无法核算" : "待补余额"}` : `${a.name}缺少${a.currency}汇率` });
  }
  // A broker statement includes cash. Never declare the sum complete while a legacy cash source can overlap it.
  for (const fund of accounts.filter(a => a.kind === "fund" && !a.excluded && a.amount !== 0)) {
    const checked = accounts.filter(a => a.kind === "broker" && !a.excluded && a.currency === fund.currency && a.reconciled && a.cash !== 0);
    if (checked.length) issues.push({ code: "cash_overlap", accountIds: [fund.id, ...checked.map(a => a.id)], message: `${fund.currency}券商余额与待归属现金需核对是否重复` });
  }
  let asset = 0, debt = 0;
  const totals = Object.fromEntries(ALLOCATION_CATEGORIES.map(c => [c, 0])) as Record<string, number | null>;
  for (const a of accounts.filter(a => !a.excluded)) {
    if (a.value !== null) { if (a.category === "debt") debt += a.value; else asset += a.value; }
    for (const [cat, value] of Object.entries(a.components)) totals[cat] = totals[cat] === null || value === null ? null : (totals[cat] ?? 0) + (value ?? 0);
  }
  const complete = !issues.some(i => ["source_unavailable", "ledger_unavailable", "ledger_item_invalid", "value_unavailable", "cash_overlap"].includes(i.code));
  const net = asset - debt;
  const banks = accounts.filter(a => a.kind === "bank"), includedBanks = banks.filter(a => !a.excluded);
  const bankValue = includedBanks.some(a => a.value === null) ? null : finite(includedBanks.reduce((sum, a) => sum + a.value!, 0));
  const snapshot: Omit<AllocationSnapshot, "snapshotRevision"> = { version: 1, accountId: userId, currency, observedAt: new Date().toISOString(),
    summary: { totalAsset: complete ? round(asset) : null, totalDebt: complete ? round(debt) : null, netAsset: complete ? round(net) : null, knownAsset: round(asset)!, complete, accountCount: accounts.filter(a => !a.excluded).length,
      portfolioTotalAsset: overview.totalAsset ?? null, difference: complete && overview.totalAsset !== null && overview.totalAsset !== undefined ? round(net - overview.totalAsset) : null },
    brokers, positions, accounts: accounts.map(a => ({ ...a, value: round(a.value), components: Object.fromEntries(Object.entries(a.components).map(([k, v]) => [k, round(v ?? null)])) })),
    bankSummary: { count: banks.length, includedCount: includedBanks.length, value: round(bankValue) },
    categories: ALLOCATION_CATEGORIES.map(id => ({ id, name: ALLOCATION_LABELS[id], value: round(totals[id]), weightPct: complete && asset > 0 && id !== "debt" && totals[id] !== null ? round(totals[id]! / asset * 100) : null })),
    issues, quoteStatus: { pending: false, cached: [], missing: [] } };
  return { ...snapshot, snapshotRevision: allocationSnapshotRevision(snapshot) };
}
