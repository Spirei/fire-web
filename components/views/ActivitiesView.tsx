"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Pagination from "@/components/Pagination";
import RefreshButton from "@/components/RefreshButton";
import CurrencySelect from "@/components/CurrencySelect";
import { usdCap } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { fmtDateTime } from "@/lib/format";
import type { SystemLog } from "@/lib/types";

interface Props {
  userLogs?: SystemLog[];
  systemLogs?: SystemLog[];
  isAdmin?: boolean;
  onRefresh?: () => Promise<void> | void;
}

type Scope = "user" | "system";
type LogLevel = "ok" | "fail" | "warn" | "info";
type DailySummary = {
  date: string;
  holdings: number;
  markets: Record<string, { holdings: number; pnl: number; date: string }>;
  settlement: string;
};

const EVENT_LABELS: Record<string, string> = {
  "auth.login.success": "登录成功",
  "auth.login.failed": "登录失败",
  "auth.login.rate_limited": "登录过于频繁",
  "auth.register.success": "注册账号",
  "auth.logout": "退出登录",
  password_change: "修改密码",
  password_change_rejected: "修改密码失败",
  profile_update: "更新资料",
  profile_email_rejected: "修改邮箱失败",
  file_upload: "上传文件",
  data_export: "导出数据",
  data_import: "导入数据",
  data_import_preview: "导入预览",
  data_import_blocked: "导入被阻止",
  data_import_rejected: "导入失败",
  records_clear: "清空持仓",
  records_clear_rejected: "清空持仓失败",
  account_delete: "注销账号",
  account_delete_rejected: "注销失败"
};

const MARKET_LABEL: Record<string, string> = { US: "美股", HK: "港股", CN: "A股" };
const PAGE_SIZE = 20;

function logLevel(event: string): LogLevel {
  if (event.includes("rate_limited")) return "warn";
  if (/failed|rejected|blocked|denied|error/.test(event)) return "fail";
  if (event === "auth.logout" || event === "account_delete") return "info";
  if (/success$|password_change$|profile_update|data_export|data_import$|data_import_preview|records_clear$|file_upload|register/.test(event)) return "ok";
  return "info";
}

function eventLabel(event: string) {
  if (EVENT_LABELS[event]) return EVENT_LABELS[event];
  return event.replace(/[._]/g, " ");
}

function clock(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dayStamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function whenLabel(iso: string) {
  const now = new Date();
  const key = dayStamp(iso);
  const today = dayStamp(now.toISOString());
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const time = clock(iso);
  if (key === today) return time;
  if (key === dayStamp(yest.toISOString())) return `昨天 ${time}`;
  if (key.slice(0, 4) === String(now.getFullYear())) return `${key.slice(5)} ${time}`;
  return `${key} ${time}`;
}

function logExtra(log: SystemLog, showUser: boolean) {
  const level = logLevel(log.event);
  const title = eventLabel(log.event);
  const detail = (log.detail || "").trim();
  const useful = detail && detail !== title && !/成功|退出登录|网页登录/.test(detail);
  const bits = [
    showUser ? log.userName : "",
    level === "fail" || level === "warn" || useful ? detail : "",
    log.ip && (level === "fail" || log.event.startsWith("auth.")) ? log.ip : ""
  ].filter(Boolean);
  return bits.join(" · ");
}

function signedMoney(value: number, symbol: string) {
  const body = Math.abs(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value >= 0 ? `+${symbol}${body}` : `−${symbol}${body}`;
}

function readQuery(): { scope: Scope; page: number; query: string } {
  if (typeof window === "undefined") return { scope: "user", page: 1, query: "" };
  const params = new URLSearchParams(window.location.search);
  const page = Number(params.get("page") || "1");
  return {
    scope: params.get("scope") === "system" ? "system" : "user",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    query: params.get("q") || ""
  };
}

function writeQuery(scope: Scope, page: number, query: string) {
  const url = new URL(window.location.href);
  if (scope === "system") url.searchParams.set("scope", "system");
  else url.searchParams.delete("scope");
  url.searchParams.delete("op");
  url.searchParams.delete("level");
  url.searchParams.delete("mod");
  url.searchParams.delete("market");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "");
  window.history.replaceState(null, "", next);
}

export default function ActivitiesView({ userLogs = [], systemLogs = [], isAdmin = false, onRefresh }: Props) {
  const initial = readQuery();
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [query, setQuery] = useState(initial.query);
  const [page, setPage] = useState(initial.page);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const { currency, setCurrency, symbol, rates, fx } = useDisplayCurrency();

  const refreshLogs = async () => {
    if (!onRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
      setLastRefreshed(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const sourceLogs = scope === "user" ? userLogs : systemLogs;
  const visibleLogs = useMemo(() => sourceLogs.filter((log) => {
    const hay = `${eventLabel(log.event)} ${log.event} ${log.detail} ${log.userName} ${log.ip}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }), [query, sourceLogs]);
  const totalPages = Math.max(1, Math.ceil(visibleLogs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageLogs = visibleLogs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const convertedMarkets = useMemo(() => {
    const map: Record<string, number> = {};
    Object.entries(dailySummary?.markets ?? {}).forEach(([market, item]) => {
      map[market] = fx(usdCap(market, item.pnl, rates));
    });
    return map;
  }, [dailySummary, fx, rates]);
  const convertedTotal = Object.values(convertedMarkets).reduce((sum, value) => sum + value, 0);
  const marketRows = (["US", "HK", "CN"] as const)
    .filter((market) => dailySummary?.markets[market]?.holdings)
    .map((market) => ({ market, label: MARKET_LABEL[market], value: convertedMarkets[market] ?? 0, count: dailySummary?.markets[market]?.holdings || 0 }));

  useEffect(() => { setPage(1); }, [scope, query]);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  useEffect(() => { writeQuery(scope, safePage, query); }, [query, safePage, scope]);

  useEffect(() => {
    if (!onRefresh) return;
    void refreshLogs();
    const timer = window.setInterval(() => { void refreshLogs(); }, 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, onRefresh, scope]);

  useEffect(() => {
    if (scope !== "user") return;
    const controller = new AbortController();
    setSummaryLoading(true);
    fetch("/api/activities/daily-summary", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setDailySummary(data); })
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setSummaryLoading(false); });
    return () => controller.abort();
  }, [lastRefreshed, scope]);

  return (
    <div className="overflow-hidden rounded-[18px] border border-edge bg-white shadow-card dark:bg-[#151b26]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge px-5 pt-4">
        <div className="flex gap-6">
          {(["user", "system"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setScope(key)}
              className={`border-b-2 pb-3 text-sm font-semibold transition ${scope === key ? "border-ink text-ink dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink dark:hover:text-white"}`}
            >
              {key === "user" ? "用户日志" : "系统日志"}
            </button>
          ))}
        </div>
        <div className="mb-3 flex w-full items-center gap-2 sm:w-auto">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索日志"
            placeholder="搜索"
            className="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm outline-none transition placeholder:text-faint focus:border-ink dark:focus:border-white sm:w-52"
          />
          {onRefresh && <RefreshButton onClick={() => void refreshLogs()} title={refreshing ? "正在刷新日志" : "刷新日志"} />}
        </div>
      </div>

      {scope === "system" && !isAdmin && <div className="p-8 text-center text-sm text-faint">系统日志仅管理员可见</div>}

      {scope === "user" && (
        <div className="px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink">前一日持仓盈亏</p>
              <p className="mt-0.5 text-[11px] text-faint">
                {summaryLoading ? "正在汇总" : [dailySummary?.date, dailySummary?.holdings ? `${dailySummary.holdings} 只` : "暂无持仓"].filter(Boolean).join(" · ")}
              </p>
            </div>
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
          <p className={`mt-3 text-[26px] font-bold leading-none tracking-tight tabular-nums ${summaryLoading || !dailySummary?.holdings ? "text-faint" : convertedTotal >= 0 ? "text-up" : "text-down"}`}>
            {summaryLoading ? "…" : dailySummary?.holdings ? signedMoney(convertedTotal, symbol) : "—"}
          </p>
          {marketRows.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] tabular-nums text-muted">
              {marketRows.map((item) => (
                <span key={item.market}>
                  {item.label}{" "}
                  <strong className={`font-semibold ${item.value >= 0 ? "text-up" : "text-down"}`}>{signedMoney(item.value, symbol)}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {(scope === "user" || (scope === "system" && isAdmin)) && (
        <>
          {pageLogs.length === 0 ? (
            <div className="border-t border-edge py-14 text-center text-sm text-faint">
              {scope === "user" ? "暂无账户记录" : "暂无系统记录"}
            </div>
          ) : (
            <ul className="border-t border-edge">
              {pageLogs.map((log) => {
                const level = logLevel(log.event);
                const extra = logExtra(log, scope === "system");
                return (
                  <li key={log.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-5 py-3.5 last:border-b-0">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        level === "fail" ? "bg-up" : level === "warn" ? "bg-[#d08a16]" : "bg-edge-strong"
                      }`}
                      aria-label={level === "fail" ? "失败" : level === "warn" ? "警告" : "记录"}
                    />
                    <div className="min-w-0">
                      <p className={`truncate text-[13px] font-medium ${level === "fail" ? "text-up" : "text-ink"}`}>{eventLabel(log.event)}</p>
                      {extra ? <p className="mt-0.5 truncate text-[11px] text-muted" title={extra}>{extra}</p> : null}
                    </div>
                    <time className="whitespace-nowrap text-[11px] tabular-nums text-faint" dateTime={log.createdAt} title={fmtDateTime(log.createdAt)}>
                      {whenLabel(log.createdAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
          {visibleLogs.length > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3 border-t border-edge px-5 py-3 text-xs text-muted">
              <span>{`${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, visibleLogs.length)} / ${visibleLogs.length}`}</span>
              <Pagination page={safePage} total={totalPages} onChange={setPage} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
