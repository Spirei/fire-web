"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import Pagination from "@/components/Pagination";
import RefreshButton from "@/components/RefreshButton";
import CurrencySelect from "@/components/CurrencySelect";
import MarketIcon from "@/components/MarketIcon";
import { usdCap } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { fmtDateTime } from "@/lib/format";
import { marketMeta, type SystemLog } from "@/lib/types";

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

const MARKETS = [
  { market: "US", label: "美股" },
  { market: "HK", label: "港股" },
  { market: "CN", label: "A股" }
] as const;

const PAGE_SIZE = 20;

function logLevel(event: string): LogLevel {
  if (event.includes("rate_limited")) return "warn";
  if (/failed|rejected|blocked|denied|error/.test(event)) return "fail";
  if (event === "auth.logout" || event === "account_delete") return "info";
  if (/success$|password_change$|profile_update|data_export|data_import$|data_import_preview|records_clear$|file_upload|register/.test(event)) return "ok";
  return "info";
}

function eventLabel(event: string) {
  return EVENT_LABELS[event] || event.replace(/[._]/g, " ");
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayStamp(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : localDay(date);
}

function clock(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dayHeading(key: string) {
  const now = new Date();
  const today = localDay(now);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (key === today) return "今天";
  if (key === localDay(yest)) return "昨天";
  const [year, month, day] = key.split("-");
  if (!month || !day) return key;
  if (year === String(now.getFullYear())) return `${Number(month)}月${Number(day)}日`;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function prettyDetail(event: string, detail: string) {
  const raw = detail.trim();
  if (!raw) return "";
  if (event === "file_upload") {
    const [kind, size, ext] = raw.split(":");
    const bytes = Number(size);
    const sizeText = Number.isFinite(bytes)
      ? bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
      : "";
    return [kind, ext, sizeText].filter(Boolean).join(" · ");
  }
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      return Object.entries(data)
        .filter(([, value]) => value != null && value !== "")
        .slice(0, 4)
        .map(([key, value]) => `${key} ${value}`)
        .join(" · ");
    } catch {
      /* 非 JSON 原文 */
    }
  }
  return raw.replace(/^username=/, "");
}

function logExtra(log: SystemLog, showUser: boolean) {
  const level = logLevel(log.event);
  const title = eventLabel(log.event);
  const detail = prettyDetail(log.event, log.detail || "");
  const useful = Boolean(detail) && detail !== title && !/成功|退出登录|网页登录/.test(detail);
  return [
    showUser ? log.userName : "",
    level === "fail" || level === "warn" || useful ? detail : "",
    log.ip && (level === "fail" || log.event.startsWith("auth.")) ? log.ip : ""
  ].filter(Boolean).join(" · ");
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
  ["op", "level", "mod", "market"].forEach((key) => url.searchParams.delete(key));
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
    <div className="w-full max-w-[800px] overflow-hidden rounded-[18px] border border-edge bg-white shadow-card dark:bg-[#151b26]">
      <div className="flex items-end justify-between gap-3 border-b border-edge px-5 pt-4">
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
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索日志"
            placeholder="搜索"
            className="h-8 w-[148px] rounded-lg border border-edge bg-transparent px-2.5 text-[13px] outline-none transition placeholder:text-faint focus:border-ink dark:focus:border-white sm:w-[180px]"
          />
          {onRefresh && <RefreshButton onClick={() => void refreshLogs()} title={refreshing ? "正在刷新日志" : "刷新日志"} />}
        </div>
      </div>

      {scope === "system" && !isAdmin && <div className="p-10 text-center text-sm text-faint">系统日志仅管理员可见</div>}

      {scope === "user" && (
        <div className="px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink">前一日持仓盈亏</p>
              <p className="mt-0.5 text-[11px] text-faint">
                {summaryLoading ? "正在汇总" : [dailySummary?.date, dailySummary?.holdings ? `${dailySummary.holdings} 只` : "暂无持仓"].filter(Boolean).join(" · ")}
              </p>
            </div>
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
          <p className={`mt-3 text-[28px] font-bold leading-none tracking-tight tabular-nums ${summaryLoading || !dailySummary?.holdings ? "text-faint" : convertedTotal >= 0 ? "text-up" : "text-down"}`}>
            {summaryLoading ? "…" : dailySummary?.holdings ? signedMoney(convertedTotal, symbol) : "—"}
          </p>
          <div className="mt-4 flex flex-wrap justify-start gap-x-8 gap-y-2">
            {MARKETS.map(({ market, label }) => {
              const has = Boolean(dailySummary?.markets[market]?.holdings);
              const value = convertedMarkets[market];
              return (
                <div key={market} className="text-left">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted">
                    <MarketIcon market={market} flag={marketMeta(market).flag} size={14} />
                    {label}
                  </p>
                  <p className={`mt-1 text-[13px] font-semibold tabular-nums ${!has || value === undefined ? "text-faint" : value >= 0 ? "text-up" : "text-down"}`}>
                    {summaryLoading ? "…" : has && value !== undefined ? signedMoney(value, symbol) : "—"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(scope === "user" || (scope === "system" && isAdmin)) && (
        <>
          {pageLogs.length === 0 ? (
            <div className="border-t border-edge py-14 text-center text-sm text-faint">
              {query ? "没有匹配的记录" : scope === "user" ? "暂无账户记录" : "暂无系统记录"}
            </div>
          ) : (
            <ul className="border-t border-edge">
              {pageLogs.map((log, index) => {
                const level = logLevel(log.event);
                const extra = logExtra(log, scope === "system");
                const day = dayStamp(log.createdAt);
                const showDay = index === 0 || day !== dayStamp(pageLogs[index - 1].createdAt);
                return (
                  <Fragment key={log.id}>
                    {showDay && (
                      <li className="border-b border-edge bg-bg-gray/50 px-5 py-1.5 text-[11px] text-muted dark:bg-white/[.03]">{dayHeading(day)}</li>
                    )}
                    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-5 py-3 last:border-b-0 transition-colors hover:bg-bg-gray/40 dark:hover:bg-white/[.03]">
                      <div className="flex min-w-0 items-start gap-2.5">
                        {(level === "fail" || level === "warn") && (
                          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${level === "fail" ? "bg-up" : "bg-[#d08a16]"}`} aria-label={level === "fail" ? "失败" : "警告"} />
                        )}
                        <div className="min-w-0">
                          <p className={`truncate text-[13px] font-medium ${level === "fail" ? "text-up" : "text-ink"}`}>{eventLabel(log.event)}</p>
                          {extra ? <p className="mt-0.5 truncate text-[11px] text-muted" title={extra}>{extra}</p> : null}
                        </div>
                      </div>
                      <time className="whitespace-nowrap text-[11px] tabular-nums text-faint" dateTime={log.createdAt} title={fmtDateTime(log.createdAt)}>
                        {clock(log.createdAt)}
                      </time>
                    </li>
                  </Fragment>
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
