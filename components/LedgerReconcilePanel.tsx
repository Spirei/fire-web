"use client";

import { IconCheck, IconChevronRight, IconDatabase, IconPencil, IconSparkles } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capsule } from "@/components/Capsule";
import { clientRequestId } from "@/lib/randomId";
import styles from "./InvestmentDataManager.module.css";

const ENDPOINT = "/api/personal-data-transfer/ledger-reconcile";
const CORE_CURRENCIES = new Set(["USD", "HKD", "CNY"]);

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
  | { kind: "position"; recordId: string; code: string; value: string; note: string; requestId: string }
  | { kind: "cash"; currency: string; value: string; note: string; requestId: string };

const fmtVal = (v: string | null | undefined) => (v == null || v === "" ? "—" : v);
const fmtTime = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 19) : "—");
const EVENT_LABELS: Record<string, string> = {
  adopt: "账本接管",
  trade: "交易提交",
  merge: "成交合并",
  repair_baseline: "基线自动核准",
  reconcile_adjustment: "人工核准",
  opening_checkpoint: "期初固化",
};
const kindLabel = (kind: string) => EVENT_LABELS[kind] ?? kind;

function isNonZero(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0;
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
  const [showZeroPositions, setShowZeroPositions] = useState(false);
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

  const visiblePositions = useMemo(() => {
    if (!state) return [];
    if (showZeroPositions) return state.positions;
    return state.positions.filter(
      (item) => isNonZero(item.quantity) || item.suggestedUnitCost != null || item.unitCost == null,
    );
  }, [state, showZeroPositions]);

  const visibleCash = useMemo(() => {
    if (!state) return [];
    if (showAllCurrencies) return state.cash;
    return state.cash.filter(
      (item) =>
        CORE_CURRENCIES.has(item.currency) ||
        isNonZero(item.balance) ||
        isNonZero(item.legacyBalance) ||
        isNonZero(item.nativeCashDelta) ||
        item.suggestedBalance != null,
    );
  }, [state, showAllCurrencies]);

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
      const label = editing.kind === "position" ? editing.code : editing.currency;
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
        <div>
          <span className={styles.reconcileBadge}>
            {state.adopted ? `原生账本 · v${state.revision}` : "旧账本直读"}
          </span>
          {state.updatedAt && <span className={styles.reconcileMeta}>更新于 {fmtTime(state.updatedAt)}</span>}
        </div>
        <span className={styles.reconcileMeta}>
          持仓 {state.positions.length} 项 · 币种 {state.cash.length} 项
        </span>
      </div>

      <div className={styles.reconcileSummary}>
        <div>
          <span className={styles.reconcileBadge}>
            <IconDatabase size={13} aria-hidden="true" />
            {state.checkpoint.sealed
              ? `单库期初已固化 · v${state.checkpoint.checkpointVersion}`
              : state.checkpoint.diskArchiveDependency
                ? "期初依赖磁盘迁移档案"
                : "尚未固化期初"}
          </span>
          {state.checkpoint.createdAt && (
            <span className={styles.reconcileMeta}>固化于 {fmtTime(state.checkpoint.createdAt)}</span>
          )}
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
                  <span>{fmtVal(item.unitCostBefore)} → {fmtVal(item.unitCostAfter)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.baselineDiff.cashUpdates.length > 0 && (
            <ul className={styles.reconcileDiffList}>
              {state.baselineDiff.cashUpdates.map((item) => (
                <li key={item.currency}>
                  <strong>{item.currency}</strong>
                  <span>{fmtVal(item.balanceBefore)} → {fmtVal(item.balanceAfter)}</span>
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

      <section className={styles.reconcileSection} aria-label="持仓成本核准">
        <div className={styles.reconcileSectionHead}>
          <h3>持仓成本</h3>
          <Capsule
            size="sm"
            variant="ghost"
            onClick={() => setShowZeroPositions((v) => !v)}
          >
            {showZeroPositions ? "仅看活跃持仓" : `显示全部（${state.positions.length}）`}
          </Capsule>
        </div>
        <div className={styles.fileList}>
          <div className={styles.reconcilePosHead} aria-hidden="true">
            <span>证券</span>
            <span>数量</span>
            <span>当前成本</span>
            <span>旧基线</span>
            <span />
          </div>
          {visiblePositions.length === 0 ? (
            <p className={styles.empty}>暂无持仓记录</p>
          ) : (
            visiblePositions.map((item) => {
              const active = editing?.kind === "position" && editing.recordId === item.recordId;
              return (
                <div key={item.recordId} className={styles.reconcilePosGroup}>
                  <div className={styles.reconcilePosRow}>
                    <span className={styles.reconcileSymbol}>
                      <strong>{item.code}</strong>
                      <small>{item.name} · {item.market}</small>
                    </span>
                    <span className={styles.reconcileNum}>{fmtVal(item.quantity)}</span>
                    <span className={styles.reconcileNum}>
                      {fmtVal(item.unitCost)}
                      {item.suggestedUnitCost && (
                        <em className={styles.reconcileSuggest}>建议 {item.suggestedUnitCost}</em>
                      )}
                    </span>
                    <span className={styles.reconcileNumMuted}>{fmtVal(item.legacyUnitCost)}</span>
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
                              code: item.code,
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
      </section>

      <section className={styles.reconcileSection} aria-label="原币现金核准">
        <div className={styles.reconcileSectionHead}>
          <h3>原币现金（全局）</h3>
          <Capsule
            size="sm"
            variant="ghost"
            onClick={() => setShowAllCurrencies((v) => !v)}
          >
            {showAllCurrencies ? "仅看主要币种" : `显示全部（${state.cash.length}）`}
          </Capsule>
        </div>
        <div className={styles.fileList}>
          <div className={styles.reconcilePosHead} aria-hidden="true">
            <span>币种</span>
            <span>当前余额</span>
            <span>接管基线</span>
            <span>原生变动</span>
            <span />
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
                    <span className={styles.reconcileNum}>
                      {fmtVal(item.balance)}
                      {item.suggestedBalance && (
                        <em className={styles.reconcileSuggest}>建议 {item.suggestedBalance}</em>
                      )}
                    </span>
                    <span className={styles.reconcileNumMuted}>{fmtVal(item.legacyBalance)}</span>
                    <span className={styles.reconcileNumMuted}>{fmtVal(item.nativeCashDelta)}</span>
                    <span className={styles.reconcileActionCell}>
                      {state.adopted && !active && (
                        <Capsule
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            setEditing({
                              kind: "cash",
                              currency: item.currency,
                              value: item.suggestedBalance ?? item.balance ?? item.legacyBalance ?? "",
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
                          placeholder="例如：核对现金余额"
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
      </section>

      {state.events.length > 0 && (
        <details className={styles.evidence}>
          <summary>
            <IconChevronRight size={14} aria-hidden="true" />
            结构化账本事件流 · {state.events.length}
          </summary>
          <div className={styles.reconcileAuditList}>
            {state.events.map((entry) => (
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
                <div className={styles.reconcileAuditTags}>
                  {entry.orders.length > 0 && <span>订单 {entry.orders.length} 笔</span>}
                  {entry.positions.slice(0, 6).map((p, idx) => (
                    <span key={`${entry.requestId}:p:${idx}`}>
                      {String(p.code ?? p.recordId ?? "持仓")}
                      {p.unitCostAfter !== undefined
                        ? `: ${fmtVal(p.unitCostBefore as string | null)} → ${fmtVal(p.unitCostAfter as string | null)}`
                        : p.unitCost !== undefined
                          ? `: ${fmtVal(p.unitCost as string | null)}`
                          : p.quantityAfter !== undefined
                            ? `: ${fmtVal(p.quantityBefore as string | null)} → ${fmtVal(p.quantityAfter as string | null)}`
                            : ""}
                    </span>
                  ))}
                  {entry.positions.length > 6 && <span>其余持仓 {entry.positions.length - 6} 项</span>}
                  {entry.cash.slice(0, 6).map((c, idx) => (
                    <span key={`${entry.requestId}:c:${idx}`}>
                      {String(c.currency ?? "现金")}
                      {c.balanceAfter !== undefined
                        ? `: ${fmtVal(c.balanceBefore as string | null)} → ${fmtVal(c.balanceAfter as string | null)}`
                        : c.balance !== undefined
                          ? `: ${fmtVal(c.balance as string | null)}`
                          : ""}
                    </span>
                  ))}
                  {entry.cash.length > 6 && <span>其余币种 {entry.cash.length - 6} 项</span>}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
