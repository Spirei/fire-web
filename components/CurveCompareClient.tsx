"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ledgerCurveSpec, type CurveBenchRow, type CurveLedgerRow, type CurveRange, type LedgerCurveKind } from "@/lib/curve";
import { curveSvg } from "@/lib/curveSvg";
import { legacyCurveSpec } from "@/lib/legacyCurve";

/** 与 public/simple-app-runtime.js 的 SIMPLE_BENCHMARKS 保持一致（诊断页专用，改动时同步） */
const BENCHMARKS: Array<{ key: string; label: string; market: string; code: string; index?: boolean }> = [
  { key: "spy", label: "标普 500", market: "US", code: "SPY" },
  { key: "qqq", label: "纳斯达克", market: "US", code: "QQQ" },
  { key: "dia", label: "道琼斯", market: "US", code: "DIA" },
  { key: "hsi", label: "恒生指数", market: "HK", code: "02800", index: true },
  { key: "sse", label: "上证指数", market: "CN", code: "sh000001", index: true }
];

const RANGES: Array<[CurveRange, string]> = [
  ["month", "本月"], ["1m", "近 1 月"], ["6m", "近 6 月"], ["ytd", "本年"], ["1y", "近 1 年"], ["all", "全部"]
];
const KINDS: Array<[LedgerCurveKind, string]> = [["mwr", "收益率曲线"], ["pnl", "累计收益曲线"]];
/** 旧实现拿「本地时刻的时间戳」比「按 UTC 解析的日期」，换个时刻窗口就会变 —— 这里手动选「它当时几点」 */
const CLOCKS: Array<[string, number | null]> = [["当前时刻", null], ["00:30", 0.5], ["08:30", 8.5], ["12:00", 12], ["23:00", 23]];

interface LedgerAccount {
  id: string;
  name: string;
  cur?: string;
  amount?: number;
  inAmt?: number;
  outAmt?: number;
  expected?: number;
  updated?: string;
  hist?: CurveLedgerRow[];
}

const LIGHT = { ink: "#262626", muted: "#8c8c8c", faint: "#bfbfbf", line: "#f0f0f0", card: "#ffffff", dash: "#d8d8d8" };
const DARK = { ink: "#eef1f6", muted: "#99a3b2", faint: "#677183", line: "#252c3a", card: "#1c222d", dash: "#3a4354" };

interface Panel {
  svg: string;
  windowStart: string;
  windowEnd: string;
  points: number;
  circles: number;
  benchPoints: number;
  domain: string;
  headline: number | null;
}

function axisLabels(svg: string): [string, string] {
  const matches = [...svg.matchAll(/<text x="346"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  return [matches[0] ?? "-", matches[1] ?? "-"];
}

export default function CurveCompareClient() {
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [defaultExpected, setDefaultExpected] = useState(8);
  const [accountId, setAccountId] = useState("");
  const [range, setRange] = useState<CurveRange>("6m");
  const [kind, setKind] = useState<LedgerCurveKind>("mwr");
  const [benchKey, setBenchKey] = useState<string>("spy");
  const [benchRows, setBenchRows] = useState<CurveBenchRow[]>([]);
  const [clockIndex, setClockIndex] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [toast, setToast] = useState("");
  const [dark, setDark] = useState(false);
  const [tick, setTick] = useState(0);

  // 命中圆点自带 onclick="toast(...)"（沿用页面里那套），这里给诊断页补一个最小实现
  useEffect(() => {
    const handler = (text: string) => setToast(text);
    (window as unknown as { toast?: (text: string) => void }).toast = handler;
    return () => { delete (window as unknown as { toast?: unknown }).toast; };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 真实账本：与简化版账户页同一个接口、同一份数据
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch("/api/v1/simple-ledger", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("ledger"))))
      .then((payload) => {
        if (cancelled) return;
        const state = payload?.data ?? payload;
        const rows: LedgerAccount[] = Array.isArray(state?.invest) ? state.invest : [];
        setAccounts(rows);
        setDefaultExpected(Number(state?.expected) || 8);
        setAccountId((current) => current || rows[0]?.id || "");
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [tick]);

  const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
  const benchmark = BENCHMARKS.find((item) => item.key === benchKey) ?? BENCHMARKS[0];

  useEffect(() => {
    let cancelled = false;
    const url = `/api/kline/full?market=${encodeURIComponent(benchmark.market)}&code=${encodeURIComponent(benchmark.code)}&limit=330${benchmark.index ? "&index=1" : ""}`;
    fetch(url, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("kline"))))
      .then((payload) => {
        if (cancelled) return;
        const items: CurveBenchRow[] = (Array.isArray(payload?.items) ? payload.items : [])
          .map((item: { d?: string; c?: number }) => ({ d: String(item.d || "").slice(0, 10), c: Number(item.c) }))
          .filter((item: CurveBenchRow) => /^\d{4}-\d{2}-\d{2}$/.test(item.d) && Number.isFinite(item.c) && item.c > 0);
        setBenchRows(items);
      })
      .catch(() => { if (!cancelled) setBenchRows([]); });
    return () => { cancelled = true; };
  }, [benchmark.key, benchmark.market, benchmark.code, benchmark.index, tick]);

  const rows = useMemo<CurveLedgerRow[]>(() => {
    const hist = account?.hist ?? [];
    return [...hist]
      .map((row) => ({ d: String(row.d).slice(0, 10), v: Number(row.v) || 0, inn: Number(row.inn) || 0, out: Number(row.out) || 0 }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.d))
      .sort((a, b) => a.d.localeCompare(b.d));
  }, [account]);

  const now = useMemo(() => {
    const clock = CLOCKS[clockIndex]?.[1];
    const base = new Date();
    if (clock === null || clock === undefined) return base;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(clock), Math.round((clock % 1) * 60));
    // 时钟选项变化 / 手动刷新时才重算
  }, [clockIndex, tick]);

  const expectedRate = account?.expected ?? defaultExpected;
  const alignEndValue = account ? (Number(account.amount) || 0) - ((Number(account.inAmt) || 0) - (Number(account.outAmt) || 0)) : null;
  const unit = account?.cur === "USD" ? "美元" : account?.cur === "HKD" ? "港元" : "元";

  const build = useCallback((legacy: boolean): Panel | null => {
    if (!rows.length) return null;
    const input = {
      rows,
      range,
      kind,
      now,
      benchmark: kind === "mwr" ? { rows: benchRows, label: benchmark.label } : null,
      expectedRate: kind === "mwr" ? expectedRate : null,
      alignEndValue: kind === "pnl" ? alignEndValue : null,
      unit
    };
    const spec = legacy ? legacyCurveSpec(input) : ledgerCurveSpec(input);
    const svg = curveSvg(spec, {
      kind,
      unit,
      theme: dark ? DARK : LIGHT,
      startLabel: (spec.meta.windowStart || spec.dates[0] || "").replaceAll("-", "."),
      endLabel: (spec.meta.windowEnd || spec.dates.at(-1) || "").replaceAll("-", ".")
    });
    const [max, min] = axisLabels(svg);
    const main = spec.series.find((item) => item.role === "main")?.values ?? [];
    return {
      svg,
      windowStart: spec.meta.windowStart ?? "-",
      windowEnd: spec.meta.windowEnd ?? "-",
      points: spec.dates.length,
      circles: (svg.match(/<circle cx="/g) || []).length,
      benchPoints: spec.series.find((item) => item.role === "bench")?.values.length ?? 0,
      domain: `${min} ~ ${max}`,
      headline: main.length ? main[main.length - 1] : null
    };
  }, [rows, range, kind, now, benchRows, benchmark.label, expectedRate, alignEndValue, unit, dark]);

  const legacyPanel = useMemo(() => build(true), [build]);
  const currentPanel = useMemo(() => build(false), [build]);

  const diff = useMemo(() => {
    if (!legacyPanel || !currentPanel) return [];
    const items: Array<{ label: string; before: string; after: string; changed: boolean }> = [
      { label: "窗口起点", before: legacyPanel.windowStart, after: currentPanel.windowStart, changed: legacyPanel.windowStart !== currentPanel.windowStart },
      { label: "采样点", before: String(legacyPanel.points), after: String(currentPanel.points), changed: legacyPanel.points !== currentPanel.points },
      { label: "命中圆点", before: String(legacyPanel.circles), after: String(currentPanel.circles), changed: legacyPanel.circles !== currentPanel.circles },
      { label: "基准线点数", before: String(legacyPanel.benchPoints), after: String(currentPanel.benchPoints), changed: legacyPanel.benchPoints !== currentPanel.benchPoints },
      {
        label: kind === "pnl" ? "区间累计收益" : "区间收益率",
        before: legacyPanel.headline === null ? "-" : kind === "pnl" ? legacyPanel.headline.toFixed(2) : `${legacyPanel.headline.toFixed(2)}%`,
        after: currentPanel.headline === null ? "-" : kind === "pnl" ? currentPanel.headline.toFixed(2) : `${currentPanel.headline.toFixed(2)}%`,
        changed: JSON.stringify(legacyPanel.headline) !== JSON.stringify(currentPanel.headline)
      }
    ];
    return items;
  }, [legacyPanel, currentPanel, kind]);

  const pill = (active: boolean) => `rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${active ? "border-edge-strong bg-white text-ink shadow-sm dark:bg-[#252c39]" : "border-edge text-muted hover:bg-bg-gray"}`;
  const field = "rounded-lg border border-edge bg-white px-2.5 py-1.5 text-xs text-ink dark:bg-[#1b2029]";

  return (
    <div className="min-h-screen bg-bg-gray px-4 py-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-4">
          <h1 className="text-lg font-extrabold text-ink">收益曲线 · 前后对比（真实数据）</h1>
          <p className="mt-1 text-xs text-muted">
            左侧复刻改动前（ef550b6）的口径，右侧是现在（lib/curve.ts + lib/curveSvg.ts）；两侧用同一份真实账本、同一个时刻，
            SVG 也都由同一套适配器渲染 —— 所以差别只来自口径本身。仅自己可见（需登录）。
          </p>
        </header>

        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-white px-3 py-2.5 dark:bg-[#1b2029]">
          <label className="flex items-center gap-2 text-xs text-muted">
            账户
            <select className={field} value={account?.id ?? ""} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.length === 0 && <option value="">（账本里还没有投资账户）</option>}
              {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.cur ? ` · ${item.cur}` : ""}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            基准
            <select className={field} value={benchKey} onChange={(event) => setBenchKey(event.target.value)} disabled={kind === "pnl"}>
              {BENCHMARKS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            旧实现按哪个时刻算
            <select className={field} value={clockIndex} onChange={(event) => setClockIndex(Number(event.target.value))}>
              {CLOCKS.map(([label], index) => <option key={label} value={index}>{label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setTick((value) => value + 1)} className="ml-auto rounded-full border border-edge-strong bg-white px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover dark:bg-[#1c1c1e] dark:text-white">重新取数</button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {RANGES.map(([value, label]) => <button key={value} type="button" onClick={() => setRange(value)} className={pill(range === value)}>{label}</button>)}
          <span className="mx-1 h-4 w-px bg-edge" />
          {KINDS.map(([value, label]) => <button key={value} type="button" onClick={() => setKind(value)} className={pill(kind === value)}>{label}</button>)}
        </div>

        {status === "loading" && <div className="rounded-xl border border-edge bg-white px-4 py-10 text-center text-sm text-muted dark:bg-[#1b2029]">正在读取账本…</div>}
        {status === "error" && <div className="rounded-xl border border-edge bg-white px-4 py-10 text-center text-sm text-muted dark:bg-[#1b2029]">账本读取失败，请确认已登录后重试。</div>}
        {status === "ready" && !rows.length && <div className="rounded-xl border border-edge bg-white px-4 py-10 text-center text-sm text-muted dark:bg-[#1b2029]">这个账户还没有每日历史（在简化版里导入或更新记录后才有曲线）。</div>}

        {status === "ready" && rows.length > 0 && legacyPanel && currentPanel && (
          <>
            <div className="mb-3 grid gap-2 rounded-xl border border-edge bg-white px-3 py-2.5 text-xs dark:bg-[#1b2029] sm:grid-cols-5">
              {diff.map((item) => (
                <div key={item.label}>
                  <div className="text-muted">{item.label}</div>
                  <div className={item.changed ? "font-semibold text-[#b4530a]" : "font-semibold text-ink"}>
                    {item.changed ? `${item.before} → ${item.after}` : item.after}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {([["改动前", "ef550b6", legacyPanel, false], ["现在", "lib/curve.ts + lib/curveSvg.ts", currentPanel, true]] as const).map(([title, subtitle, panel, isCurrent]) => (
                <div key={title} className={`rounded-xl border border-edge bg-white p-3 dark:bg-[#1b2029] ${isCurrent ? "ring-1 ring-[#3297f6]/30" : ""}`}>
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 className="text-sm font-bold text-ink">{title}</h2>
                    <span className="text-[11px] text-muted">{subtitle}</span>
                  </div>
                  {/* SVG 本身不带尺寸（页面里由 simple-app 的 CSS 给高度），这里补上宽度自适应 */}
                  <div className="[&_svg]:block [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: panel.svg }} />
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted sm:grid-cols-3">
                    <span>窗口 <b className="text-ink">{panel.windowStart}</b></span>
                    <span>止于 <b className="text-ink">{panel.windowEnd}</b></span>
                    <span>采样点 <b className="text-ink">{panel.points}</b></span>
                    <span>命中圆点 <b className={panel.circles > 300 ? "text-[#b4530a]" : "text-ink"}>{panel.circles}</b></span>
                    <span>基准线 <b className="text-ink">{panel.benchPoints}</b></span>
                    <span>纵轴 <b className="text-ink">{panel.domain}</b></span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-edge bg-white px-3 py-3 text-xs leading-relaxed text-muted dark:bg-[#1b2029]">
              <p className="mb-1 font-semibold text-ink">怎么看</p>
              <p>· 两侧的曲线数值算法（Modified Dietz 资金加权 / 累计收益）本来就一致，逐值验证过；会变的只有「窗口起点」和「基准线怎么对齐日期」。</p>
              <p>· 旧实现用 setMonth 回退算周期，遇到月末（31 日）会越界，窗口被吞掉将近一个月；而且它拿「本地时刻的时间戳」比「按 UTC 解析的日期」，所以把上面的时刻切到 00:30 / 12:00，窗口起点会跟着变。</p>
              <p>· 旧实现画基准线时只取窗口内的点，再按自己的点数均分到整张图（时间轴错位）；新实现按日期对齐、之前回填首值。</p>
              <p>· 命中圆点是「每个数据点一个 DOM 节点」的开销，新实现抽稀到约 180 个并保留首尾与极值日；曲线本身仍是全量点。</p>
            </div>
          </>
        )}
      </div>
      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-50 mx-auto w-fit rounded-full bg-[#101010]/92 px-4 py-2 text-xs text-white shadow-lg">{toast}</div>
      )}
    </div>
  );
}
