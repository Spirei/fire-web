"use client";

import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
  IconCheck,
  IconDatabase,
  IconPencil,
  IconSparkles,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capsule } from "@/components/Capsule";
import { clientRequestId } from "@/lib/randomId";
import styles from "./InvestmentDataManager.module.css";

const ENDPOINT = "/api/personal-data-transfer/ledger-reconcile";
const CORE_CURRENCIES = new Set(["USD", "HKD", "CNY"]);

type SectionTab = "positions" | "cash" | "events";
type PositionSortKey = "name" | "quantity" | "unitCost" | "legacyUnitCost";
type CashSortKey = "currency" | "balance" | "legacyBalance" | "nativeCashDelta";
type SortDir = "asc" | "desc";

type ReconcilePosition = {
  recordId: string;
  market: string;
  code: string;
  name: string;
  brokerAccountId: string | null;
  quantity: string | null;
  unitCost: string | null;
  legacyQuantity: string | null;
  legacyUnitCost: string | null;
  suggestedUnitCost: string | null;
  nativeFillCount: number;
};

type ReconcileCash = {
  currency: string;
  balance: string | null;
  legacyBalance: string | null;
  nativeCashDelta: string;
  suggestedBalance: string | null;
};

type PositionUpdate = {
  recordId: string;
  market: string;
  code: string;
  unitCostBefore: string | null;
  unitCostAfter: string | null;
};

type CashUpdate = {
  currency: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
};

type CheckpointStatus = {
  sealed: boolean;
  checkpointVersion: number;
  sourceAuthority: string | null;
  sourceSha256: string | null;
  createdAt: string | null;
  note: string;
  diskArchiveDependency: boolean;
  canSeal: boolean;
};

type LedgerEventRow = {
  seq: number;
  revision: number | null;
  requestId: string;
  kind: string;
  occurredAt: string;
  createdAt: string;
  note: string;
  orders: Record<string, unknown>[];
  positions: Record<string, unknown>[];
  cash: Record<string, unknown>[];
};

type ReconcileState = {
  ownerId: string;
  adopted: boolean;
  revision: number;
  updatedAt: string | null;
  positions: ReconcilePosition[];
  cash: ReconcileCash[];
  checkpoint: CheckpointStatus;
  baselineDiff: {
    hasGaps: boolean;
    positionUpdates: PositionUpdate[];
    cashUpdates: CashUpdate[];
    warnings: { recordId: string; code: string; message: string }[];
  };
  recentAdjustments: {
    requestId: string;
    revision: number;
    kind: string;
    note: string;
    createdAt: string;
    positionUpdates: PositionUpdate[];
    cashUpdates: CashUpdate[];
  }[];
  events: LedgerEventRow[];
};

type EditingTarget =
  | { kind: "position"; recordId: string; label: string; value: string; note: string; requestId: string }
  | { kind: "cash"; currency: string; value: string; note: string; requestId: string };

const CASH_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COST_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const QTY_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });

const EVENT_LABELS: Record<string, string> = {
  adopt: "账本接管",
  trade: "交易提交",
  merge: "成交合并",
  repair_baseline: "基线自动核准",
  reconcile_adjustment: "人工核准",
  opening_checkpoint: "期初固化",
};
const kindLabel = (kind: string) => EVENT_LABELS[kind] ?? kind;

function parseNum(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isNonZero(value: string | null | undefined): boolean {
  const n = parseNum(value);
  return n !== null && n !== 0;
}

function fmtCash(value: string | null | undefined): string {
  const n = parseNum(value);
  if (n === null) return "—";
  const safe = Object.is(n, -0) ? 0 : n;
  return CASH_FMT.format(safe);
}

function fmtCost(value: string | null | undefined): string {
  const n = parseNum(value);
  if (n === null) return "—";
  return COST_FMT.format(Object.is(n, -0) ? 0 : n);
}

function fmtQty(value: string | null | undefined): string {
  const n = parseNum(value);
  if (n === null) return "—";
  return QTY_FMT.format(Object.is(n, -0) ? 0 : n);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.replace("T", " ").slice(0, 19);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function compareNullableNum(a: string | null, b: string | null, dir: SortDir): number {
  const na = parseNum(a);
  const nb = parseNum(b);
  if (na === null && nb === null) return 0;
  if (na === null) return 1;
  if (nb === null) return -1;
  return dir === "asc" ? na - nb : nb - na;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <IconArrowsSort size={13} aria-hidden="true" className={styles.sortIdle} />;
  return dir === "asc" ? <IconArrowUp size={13} aria-hidden="true" /> : <IconArrowDown size={13} aria-hidden="true" />;
}

function formatEventTags(entry: LedgerEventRow): string[] {
  const tags: string[] = [];
  if (entry.orders.length > 0) {
    tags.push(`订单 ${entry.orders.length} 笔`);
  }
  if (entry.kind === "opening_checkpoint") {
    const nonZeroCash = entry.cash.filter((c) => isNonZero(c.balance as string | null));
    tags.push(`存量持仓 ${entry.positions.length} 项`);
    tags.push(`原币现金 ${entry.cash.length} 项`);
    for (const c of nonZeroCash.slice(0, 4)) {
      tags.push(`${String(c.currency)}: ${fmtCash(c.balance as string | null)}`);
    }
    return tags;
  }
  if (entry.kind === "trade") {
    for (const p of entry.positions.slice(0, 6)) {
      const code = String(p.code ?? p.recordId ?? "持仓");
      const qtyPart =
        p.quantityBefore !== undefined && p.quantityAfter !== undefined
          ? `${fmtQty(p.quantityBefore as string | null)} → ${fmtQty(p.quantityAfter as string | null)} 股`
          : "";
      const costPart = p.unitCostAfter != null ? ` · 成本 ${fmtCost(p.unitCostAfter as string)}` : "";
      tags.push(`${code}${qtyPart ? `: ${qtyPart}` : ""}${costPart}`);
    }
    for (const c of entry.cash.slice(0, 4)) {
      const currency = String(c.currency ?? "现金");
      const before = fmtCash(c.balanceBefore as string | null);
      const after = fmtCash(c.balanceAfter as string | null);
      if (before === "—" && after === "—") {
        tags.push(`${currency}: 未记录期初`);
      } else {
        tags.push(`${currency}: ${before} → ${after}`);
      }
    }
    return tags;
  }
  for (const p of entry.positions.slice(0, 6)) {
    const code = String(p.code ?? p.recordId ?? "持仓");
    tags.push(`${code}: ${fmtCost(p.unitCostBefore as string | null)} → ${fmtCost(p.unitCostAfter as string | null)}`);
  }
  if (entry.positions.length > 6) tags.push(`其余持仓 ${entry.positions.length - 6} 项`);
  const nonZeroCash = entry.cash.filter(
    (c) => isNonZero(c.balanceBefore as string | null) || isNonZero(c.balanceAfter as string | null),
  );
  const cashShown = nonZeroCash.length > 0 ? nonZeroCash : entry.cash.slice(0, 4);
  for (const c of cashShown.slice(0, 6)) {
    const currency = String(c.currency ?? "现金");
    tags.push(`${currency}: ${fmtCash(c.balanceBefore as string | null)} → ${fmtCash(c.balanceAfter as string | null)}`);
  }
  const hiddenCash = entry.cash.length - Math.min(cashShown.length, 6);
  if (hiddenCash > 0) tags.push(`其余零余额币种 ${hiddenCash} 项`);
  return tags;
}

export default function LedgerReconcilePanel({
  ownerId,
  refreshToken = 0,
}: {
  ownerId: string;
  refreshToken?: number;
}) {
  const [state, setState] = useState<ReconcileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SectionTab>("positions");
  const [showZeroPositions, setShowZeroPositions] = useState(false);
  const [positionQuery, setPositionQuery] = useState("");
  const [posSort, setPosSort] = useState<{ key: PositionSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [cashSort, setCashSort] = useState<{ key: CashSortKey; dir: SortDir }>({ key: "currency", dir: "asc" });
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const baselineRequestId = useRef<string | null>(null);
  const checkpointRequestId = useRef<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(ENDPOINT, {
        signal,
        cache: "no-store",
        headers: { "X-Alcor-Expected-Account": ownerId },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : "读取账本核准数据失败");
      }
      if (signal?.aborted) return;
      setState(body as ReconcileState);
      baselineRequestId.current = null;
      checkpointRequestId.current = null;
    } catch (err) {
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : "读取账本核准数据失败");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshToken]);

  function togglePosSort(key: PositionSortKey) {
    setPosSort((curr) =>
      curr.key === key ? { key, dir: curr.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" },
    );
  }

  function toggleCashSort(key: CashSortKey) {
    setCashSort((curr) =>
      curr.key === key ? { key, dir: curr.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "currency" ? "asc" : "desc" },
    );
  }

  const visiblePositions = useMemo(() => {
    if (!state) return [];
    const keyword = positionQuery.trim().toLowerCase();
    const filtered = state.positions.filter((item) => {
      if (!showZeroPositions && !isNonZero(item.quantity) && item.suggestedUnitCost == null && item.unitCost != null) {
        return false;
      }
      if (!keyword) return true;
      return (
        item.code.toLowerCase().includes(keyword) ||
        item.name.toLowerCase().includes(keyword) ||
        item.market.toLowerCase().includes(keyword)
      );
    });
    return [...filtered].sort((a, b) => {
      if (posSort.key === "name") {
        const cmp = a.name.localeCompare(b.name, "zh-Hans-CN") || a.code.localeCompare(b.code);
        return posSort.dir === "asc" ? cmp : -cmp;
      }
      if (posSort.key === "quantity") return compareNullableNum(a.quantity, b.quantity, posSort.dir);
      if (posSort.key === "unitCost") return compareNullableNum(a.unitCost, b.unitCost, posSort.dir);
      return compareNullableNum(a.legacyUnitCost, b.legacyUnitCost, posSort.dir);
    });
  }, [state, showZeroPositions, positionQuery, posSort]);

  const visibleCash = useMemo(() => {
    if (!state) return [];
    const filtered = showAllCurrencies
      ? state.cash
      : state.cash.filter(
          (item) =>
            CORE_CURRENCIES.has(item.currency) ||
            isNonZero(item.balance) ||
            isNonZero(item.legacyBalance) ||
            isNonZero(item.nativeCashDelta) ||
            item.suggestedBalance != null,
        );
    return [...filtered].sort((a, b) => {
      if (cashSort.key === "currency") {
        const cmp = a.currency.localeCompare(b.currency);
        return cashSort.dir === "asc" ? cmp : -cmp;
      }
      if (cashSort.key === "balance") return compareNullableNum(a.balance, b.balance, cashSort.dir);
      if (cashSort.key === "legacyBalance") return compareNullableNum(a.legacyBalance, b.legacyBalance, cashSort.dir);
      return compareNullableNum(a.nativeCashDelta, b.nativeCashDelta, cashSort.dir);
    });
  }, [state, showAllCurrencies, cashSort]);

  async function sealCheckpoint() {
    if (!state || !state.checkpoint.canSeal || busy) return;
    setBusy(true);
    setNotice(null);
    const requestId = checkpointRequestId.current ?? clientRequestId();
    checkpointRequestId.current = requestId;
    try {
      const response = await fetch(`${ENDPOINT}/checkpoint`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Alcor-Expected-Account": ownerId,
        },
        body: JSON.stringify({ requestId, note: "固化期初核准点至单一 PG 库" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : "固化期初未完成");
      }
      checkpointRequestId.current = null;
      setNotice({
        text: `已固化期初核准点（v${body?.checkpointVersion ?? 1}）：原币现金 ${body?.cashCurrencies ?? 0} 项、存量持仓 ${body?.positionCount ?? 0} 项。`,
      });
      window.dispatchEvent(new Event("fire:funds-updated"));
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "固化期初未完成", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function applyBaseline() {
    if (!state || !state.adopted || busy) return;
    setBusy(true);
    setNotice(null);
    const requestId = baselineRequestId.current ?? clientRequestId();
    baselineRequestId.current = requestId;
    try {
      const response = await fetch(`${ENDPOINT}/baseline`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Alcor-Expected-Account": ownerId,
        },
        body: JSON.stringify({
          requestId,
          baseRevision: state.revision,
          note: "数据管理一键基线核准",
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) baselineRequestId.current = null;
        throw new Error(typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : "基线核准未完成");
      }
      baselineRequestId.current = null;
      const posCount = Array.isArray(body?.positionUpdates) ? body.positionUpdates.length : 0;
      const cashCount = Array.isArray(body?.cashUpdates) ? body.cashUpdates.length : 0;
      setNotice({ text: `已核准基线（版本 v${body?.sourceRevision ?? state.revision + 1}）：持仓 ${posCount} 项、原币现金 ${cashCount} 项。` });
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:funds-updated"));
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "基线核准未完成", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!state || !state.adopted || !editing || busy) return;
    const trimmed = editing.value.trim();
    const normalized = trimmed === "" ? null : trimmed;
    if (normalized !== null && !/^-?\d+(?:\.\d{1,16})?$/.test(normalized)) {
      setNotice({ text: "请输入合法数字（最多 16 位小数，留空表示清空）", error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const payload =
        editing.kind === "position"
          ? {
              requestId: editing.requestId,
              baseRevision: state.revision,
              note: editing.note.trim(),
              positions: [{ recordId: editing.recordId, unitCost: normalized }],
              cash: [],
            }
          : {
              requestId: editing.requestId,
              baseRevision: state.revision,
              note: editing.note.trim(),
              positions: [],
              cash: [{ currency: editing.currency, balance: normalized }],
            };
      const response = await fetch(`${ENDPOINT}/adjust`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Alcor-Expected-Account": ownerId,
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          setEditing((curr) => (curr ? { ...curr, requestId: clientRequestId() } : null));
        }
        throw new Error(typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : "核准提交未完成");
      }
      const label = editing.kind === "position" ? editing.label : editing.currency;
      setEditing(null);
      setNotice({ text: `已核准 ${label}（版本 v${body?.sourceRevision ?? state.revision + 1}）。` });
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:funds-updated"));
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "核准提交未完成", error: true });
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className={styles.readError}>
        <p role="alert">{error}</p>
        <Capsule size="sm" variant="secondary" onClick={() => void load()}>重试</Capsule>
      </div>
    );
  }

  if (loading && !state) {
    return (
      <div className={styles.fileList}>
        <div className={styles.placeholder} role="status" aria-label="正在读取账本核准数据">
          <i /><i /><i />
        </div>
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className={styles.reconcileStack}>
      <div className={styles.reconcileSummary}>
        <div className={styles.reconcileStatusGroup}>
          <span className={styles.reconcileBadge}>
            {state.adopted ? `原生账本 · v${state.revision}` : "旧账本直读"}
          </span>
          <span className={styles.reconcileBadge}>
            <IconDatabase size={13} aria-hidden="true" />
            {state.checkpoint.sealed
              ? `单库期初已固化 · v${state.checkpoint.checkpointVersion}`
              : state.checkpoint.diskArchiveDependency
                ? "期初依赖磁盘迁移档案"
                : "尚未固化期初"}
          </span>
          {state.updatedAt && <span className={styles.reconcileMeta}>更新于 {fmtTime(state.updatedAt)}</span>}
        </div>
        {state.checkpoint.canSeal && (
          <Capsule
            size="sm"
            variant={state.checkpoint.sealed ? "secondary" : "primary"}
            busy={busy}
            onClick={() => void sealCheckpoint()}
          >
            {state.checkpoint.sealed ? "重新固化期初" : "固化期初到单库"}
          </Capsule>
        )}
      </div>

      {notice && (
        <p className={notice.error ? styles.reconcileError : styles.reconcileNotice} role={notice.error ? "alert" : "status"}>
          {notice.text}
        </p>
      )}

      {state.adopted && (state.baselineDiff.hasGaps || state.baselineDiff.warnings.length > 0) && (
        <section className={styles.reconcileAlert} aria-label="待核准基线缺口">
          <div className={styles.reconcileAlertHead}>
            <div>
              <h3><IconSparkles size={16} aria-hidden="true" />发现可自动回填的基线缺口</h3>
              <p>
                持仓成本 {state.baselineDiff.positionUpdates.length} 项 · 原币现金 {state.baselineDiff.cashUpdates.length} 项
              </p>
            </div>
            {state.baselineDiff.hasGaps && (
              <Capsule size="sm" variant="primary" busy={busy} onClick={() => void applyBaseline()}>
                <IconCheck size={15} aria-hidden="true" />一键核准基线
              </Capsule>
            )}
          </div>
          {state.baselineDiff.positionUpdates.length > 0 && (
            <ul className={styles.reconcileDiffList}>
              {state.baselineDiff.positionUpdates.map((item) => (
                <li key={item.recordId}>
                  <strong>{item.code}</strong>
                  <span>{fmtCost(item.unitCostBefore)} → {fmtCost(item.unitCostAfter)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.baselineDiff.cashUpdates.length > 0 && (
            <ul className={styles.reconcileDiffList}>
              {state.baselineDiff.cashUpdates.map((item) => (
                <li key={item.currency}>
                  <strong>{item.currency}</strong>
                  <span>{fmtCash(item.balanceBefore)} → {fmtCash(item.balanceAfter)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.baselineDiff.warnings.length > 0 && (
            <ul className={styles.reconcileWarnList}>
              {state.baselineDiff.warnings.map((w) => (
                <li key={w.recordId}>{w.code}：{w.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className={styles.reconcileTabBar}>
        <nav className={styles.previewNav} aria-label="账本核准分类">
          <button
            type="button"
            aria-pressed={tab === "positions"}
            onClick={() => { setTab("positions"); setEditing(null); }}
          >
            持仓成本 ({state.positions.length})
          </button>
          <button
            type="button"
            aria-pressed={tab === "cash"}
            onClick={() => { setTab("cash"); setEditing(null); }}
          >
            原币现金 ({state.cash.length})
          </button>
          <button
            type="button"
            aria-pressed={tab === "events"}
            onClick={() => { setTab("events"); setEditing(null); }}
          >
            事件流 ({state.events.length})
          </button>
        </nav>

        {tab === "positions" && (
          <div className={styles.reconcileSectionControls}>
            <input
              type="search"
              className={styles.reconcileFilterInput}
              value={positionQuery}
              onChange={(e) => setPositionQuery(e.target.value)}
              placeholder="筛选股票或代码"
              aria-label="筛选股票名称或代码"
            />
            <Capsule
              size="sm"
              variant="ghost"
              onClick={() => setShowZeroPositions((v) => !v)}
            >
              {showZeroPositions ? "仅看活跃" : `全部 (${state.positions.length})`}
            </Capsule>
          </div>
        )}

        {tab === "cash" && (
          <div className={styles.reconcileSectionControls}>
            <Capsule
              size="sm"
              variant="ghost"
              onClick={() => setShowAllCurrencies((v) => !v)}
            >
              {showAllCurrencies ? "仅看主要币种" : `全部 (${state.cash.length})`}
            </Capsule>
          </div>
        )}
      </div>

      {tab === "positions" && (
        <div className={styles.fileList}>
          <div className={styles.reconcilePosHead}>
            <button type="button" className={styles.sortBtn} onClick={() => togglePosSort("name")}>
              股票/代码 <SortIcon active={posSort.key === "name"} dir={posSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => togglePosSort("quantity")}>
              数量 <SortIcon active={posSort.key === "quantity"} dir={posSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => togglePosSort("unitCost")}>
              当前成本 <SortIcon active={posSort.key === "unitCost"} dir={posSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => togglePosSort("legacyUnitCost")}>
              旧基线 <SortIcon active={posSort.key === "legacyUnitCost"} dir={posSort.dir} />
            </button>
            <span className={styles.reconcileHeadAction}>操作</span>
          </div>
          {visiblePositions.length === 0 ? (
            <p className={styles.empty}>暂无匹配的持仓记录</p>
          ) : (
            visiblePositions.map((item) => {
              const active = editing?.kind === "position" && editing.recordId === item.recordId;
              return (
                <div key={item.recordId} className={styles.reconcilePosGroup}>
                  <div className={styles.reconcilePosRow}>
                    <span className={styles.reconcileSymbol}>
                      <strong>{item.name}</strong>
                      <small>{item.code} · {item.market}</small>
                    </span>
                    <span className={styles.reconcileNum} title={item.quantity ?? undefined}>
                      {fmtQty(item.quantity)}
                    </span>
                    <span className={styles.reconcileNum} title={item.unitCost ?? undefined}>
                      {item.unitCost == null && isNonZero(item.quantity) ? (
                        <em className={styles.reconcileMissing}>缺成本</em>
                      ) : (
                        fmtCost(item.unitCost)
                      )}
                      {item.suggestedUnitCost && (
                        <em className={styles.reconcileSuggest}>建议 {fmtCost(item.suggestedUnitCost)}</em>
                      )}
                    </span>
                    <span className={styles.reconcileNumMuted} title={item.legacyUnitCost ?? undefined}>
                      {fmtCost(item.legacyUnitCost)}
                    </span>
                    <span className={styles.reconcileActionCell}>
                      {state.adopted && !active && (
                        <Capsule
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            setEditing({
                              kind: "position",
                              recordId: item.recordId,
                              label: `${item.name} (${item.code})`,
                              value: item.suggestedUnitCost ?? item.unitCost ?? item.legacyUnitCost ?? "",
                              note: "",
                              requestId: clientRequestId(),
                            });
                          }}
                        >
                          <IconPencil size={13} aria-hidden="true" />核准
                        </Capsule>
                      )}
                    </span>
                  </div>
                  {active && (
                    <div className={styles.reconcileEditor}>
                      <label>
                        <span>单位成本</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          placeholder="留空则置为空"
                        />
                      </label>
                      <label>
                        <span>备注（可选）</span>
                        <input
                          type="text"
                          value={editing.note}
                          onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                          placeholder="例如：按券商结单核对"
                        />
                      </label>
                      <div className={styles.reconcileEditorActions}>
                        <Capsule size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
                          取消
                        </Capsule>
                        <Capsule size="sm" variant="primary" busy={busy} onClick={() => void submitEdit()}>
                          确认核准
                        </Capsule>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === "cash" && (
        <div className={styles.fileList}>
          <div className={styles.reconcilePosHead}>
            <button type="button" className={styles.sortBtn} onClick={() => toggleCashSort("currency")}>
              币种 <SortIcon active={cashSort.key === "currency"} dir={cashSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => toggleCashSort("balance")}>
              当前余额 <SortIcon active={cashSort.key === "balance"} dir={cashSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => toggleCashSort("legacyBalance")}>
              接管基线 <SortIcon active={cashSort.key === "legacyBalance"} dir={cashSort.dir} />
            </button>
            <button type="button" className={styles.sortBtnEnd} onClick={() => toggleCashSort("nativeCashDelta")}>
              原生变动 <SortIcon active={cashSort.key === "nativeCashDelta"} dir={cashSort.dir} />
            </button>
            <span className={styles.reconcileHeadAction}>操作</span>
          </div>
          {visibleCash.length === 0 ? (
            <p className={styles.empty}>暂无原币现金记录</p>
          ) : (
            visibleCash.map((item) => {
              const active = editing?.kind === "cash" && editing.currency === item.currency;
              return (
                <div key={item.currency} className={styles.reconcilePosGroup}>
                  <div className={styles.reconcilePosRow}>
                    <span className={styles.reconcileSymbol}><strong>{item.currency}</strong></span>
                    <span className={styles.reconcileNum} title={item.balance ?? undefined}>
                      {fmtCash(item.balance)}
                      {item.suggestedBalance && (
                        <em className={styles.reconcileSuggest}>建议 {fmtCash(item.suggestedBalance)}</em>
                      )}
                    </span>
                    <span className={styles.reconcileNumMuted} title={item.legacyBalance ?? undefined}>
                      {fmtCash(item.legacyBalance)}
                    </span>
                    <span className={styles.reconcileNumMuted} title={item.nativeCashDelta}>
                      {fmtCash(item.nativeCashDelta)}
                    </span>
                    <span className={styles.reconcileActionCell}>
                      {state.adopted && !active && (
                        <Capsule
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            const raw = item.suggestedBalance ?? item.balance ?? item.legacyBalance ?? "";
                            const n = parseNum(raw);
                            const cleanDefault =
                              n !== null && raw.includes(".") && raw.split(".")[1].length > 4
                                ? n.toFixed(2)
                                : raw;
                            setEditing({
                              kind: "cash",
                              currency: item.currency,
                              value: cleanDefault,
                              note: "",
                              requestId: clientRequestId(),
                            });
                          }}
                        >
                          <IconPencil size={13} aria-hidden="true" />核准
                        </Capsule>
                      )}
                    </span>
                  </div>
                  {active && (
                    <div className={styles.reconcileEditor}>
                      <label>
                        <span>核准后余额（{item.currency}）</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          placeholder="输入精确原币余额"
                        />
                      </label>
                      <label>
                        <span>备注（可选）</span>
                        <input
                          type="text"
                          value={editing.note}
                          onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                          placeholder="例如：消除历史浮点尾差"
                        />
                      </label>
                      <div className={styles.reconcileEditorActions}>
                        <Capsule size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
                          取消
                        </Capsule>
                        <Capsule size="sm" variant="primary" busy={busy} onClick={() => void submitEdit()}>
                          确认核准
                        </Capsule>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === "events" && (
        state.events.length === 0 ? (
          <div className={styles.fileList}>
            <p className={styles.empty}>暂无结构化账本事件</p>
          </div>
        ) : (
          <div className={styles.reconcileAuditList}>
            {state.events.map((entry) => {
              const tags = formatEventTags(entry);
              return (
                <div key={entry.requestId} className={styles.reconcileAuditItem}>
                  <div className={styles.reconcileAuditHead}>
                    <strong>
                      #{entry.seq}
                      {entry.revision != null ? ` · v${entry.revision}` : ""}
                      {` · ${kindLabel(entry.kind)}`}
                    </strong>
                    <span>{fmtTime(entry.occurredAt || entry.createdAt)}</span>
                  </div>
                  {entry.note && <p className={styles.reconcileAuditNote}>{entry.note}</p>}
                  {tags.length > 0 && (
                    <div className={styles.reconcileAuditTags}>
                      {tags.map((tag, idx) => (
                        <span key={`${entry.requestId}:${idx}`}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
