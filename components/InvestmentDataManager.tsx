"use client";

import { IconArchive, IconArrowsExchange, IconBriefcase, IconChartLine, IconChevronRight, IconCopy, IconFileDescription, IconFolder, IconDownload, IconHistory, IconReceipt } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import { Capsule } from "@/components/Capsule";
import { copyText } from "@/lib/clipboard";
import styles from "./InvestmentDataManager.module.css";

const ROOT = "/api/personal-data-transfer";
const FOLDERS = [
  { key: "daily", title: "每日盈亏", icon: IconChartLine },
  { key: "positions", title: "持仓", icon: IconBriefcase },
  { key: "trades", title: "成交与订单", icon: IconReceipt },
  { key: "funds", title: "资金流水", icon: IconArrowsExchange },
  { key: "corrections", title: "更正记录", icon: IconHistory },
  { key: "originals", title: "来源原件", icon: IconFileDescription },
  { key: "archive", title: "账本档案", icon: IconArchive },
] as const;
type Folder = typeof FOLDERS[number]["key"];
type Data = Record<string, unknown>;
type LedgerRow = { type: string; id: string; at: string; data: Data };
type DailyRow = { day: string; revision: number; state: string; pnl: string | null; currency: string };
type PeriodFolder = { year: number; month?: number; count: number };
type Row = LedgerRow | DailyRow | PeriodFolder;
type Cursor = [string, string, string] | string | null;
type OriginalFile = { name: string; rows?: Data[] };
type LedgerDetail = { type: string; id: string; data: Data; links: { type: string; id: string; field: string }[];
  version?: { revision: number; action: string }; versions?: { revision: number; action: string }[]; file?: OriginalFile };
type DailyDocument = DailyRow & {
  cutoff: string; capturedAt: string; inputSha256: string; rule: string; equity: string | null;
  priorEquity: string | null; externalFlow: string | null; priorRevision: number | null;
  positions: (Data & { recordId: string; close: Data | null })[];
  cashPostings: (Data & { id: string })[]; cashOpenings: Data[];
  cashByCurrency: Data; closeValueByCurrency: Data; externalFlowByCurrency: Data;
  fx: Record<string, Data>; cashPostingCount: number; cashPostingsSha256: string;
  missing: (Data & { reason: string })[];
};
type DailyDetail = DailyDocument & { revisions: number[] };
type FileDetail = { data: DailyDetail | LedgerDetail; source: string };
type Selection = { day: string; revision: number } | { type: string; id: string; revision?: number; filename?: string };

const LABELS: Record<string, string> = {
  position: "持仓", trade: "成交", appFill: "App 成交", declaration: "历史订单",
  cash: "资金分录", amendment: "成交更正", feeCorrection: "费用更正", fundReversal: "资金冲回", cashCorrection: "余额更正",
  transfer: "转仓", statement: "券商账单", orderFile: "订单原件", financialImport: "账本导入原件", historyImport: "迁移原件",
  buy: "买入", sell: "卖出", dividend: "股息", opening: "期初",
  external_deposit: "入金", external_withdrawal: "出金", trade_buy: "买入扣款",
  trade_sell: "卖出入账", trade_dividend: "股息入账", fee_correction: "费用更正",
  trade_correction: "成交更正", reconcile_balance: "余额核对", allocation: "余额分配",
  complete: "完整", partial: "待补依据", missing: "缺失",
};
const FIELDS: Record<string, string> = {
  recordId: "持仓编号", recordRevision: "持仓版本", tradeId: "成交编号", amendmentId: "更正编号",
  record_id: "持仓编号", trade_id: "成交编号", request_id: "请求编号", source: "来源", sourceRevision: "来源版本",
  originalPageId: "原件编号", originalSha256: "原件 SHA-256", factId: "行情记录编号",
  sourceTime: "源时间", observedAt: "入库时间", tradeDay: "交易日", marketCalendarRevision: "交易日历版本",
  licenseRevision: "授权版本", quantity: "数量", code: "证券代码", market: "市场", cost: "成本",
  value: "金额", amount: "金额", currency: "币种", price: "价格", fees: "费用", rate: "汇率",
  occurred_at: "发生时间", created_at: "登记时间", updated_at: "更新时间", kind: "类型", side: "方向",
  brokerAccountId: "券商账户", account_id: "券商账户", recordedAt: "持仓记录时间", adjustment: "复权口径",
  session: "交易时段", observationId: "汇率记录编号", observationDay: "汇率日期", frozenAt: "汇率冻结时间", basis: "口径", dateBasis: "日期依据",
  before_event: "更正前", replacement: "更正后", evidence: "依据", evidence_sha256: "依据 SHA-256",
  pnl: "日终盈亏", equity: "日终净值", priorEquity: "前一日净值", externalFlow: "当日净入金", missing: "待补依据",
};
const REASONS: Record<string, string> = {
  missing_prior_equity: "缺少前一日净值", missing_close: "缺少有效收盘价", missing_historical_fx: "缺少当日汇率",
  missing_market_calendar: "缺少已核对的交易日历", missing_cash_opening: "缺少现金期初余额",
  unassigned_position: "持仓尚未关联券商账户", position_revision_after_cutoff: "持仓有截点之后的变更",
  official_position_needs_statement: "官方持仓需要历史券商账单", missing_position_quantity: "缺少持仓数量",
  prior_period_posting_changed: "发现影响前一日净值的补录", unclassified_cash_adjustment: "存在待归类的资金调整",
  unattributed_position_change: "持仓变动缺少相应成交依据", close_source_ambiguous: "收盘价有多个候选来源",
  close_source_unavailable: "行情授权不可用", unverified_close: "收盘价原件未通过验证", unsupported_market: "市场暂不支持日终估值",
  account_limit: "账户超过本次读取范围", position_limit: "持仓超过本次读取范围", cash_posting_limit: "流水超过本次读取范围",
  missing_account: "缺少有效券商账户",
};
const TRANSLATED: Record<string, string> = { same_currency: "同币种", native_per_usd: "每美元对应原币", same_day: "当日发布",
  weekend_carry_forward: "周末沿用周五报价", none: "不复权", REGULAR: "常规时段" };
const display = (value: unknown): string => value == null || value === "" ? "—" : typeof value === "string" ? TRANSLATED[value] ?? LABELS[value] ?? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value, null, 2);
const datePart = (value: unknown) => typeof value === "string" ? value.slice(0, 10) : "—";
const dailyFilename = (day: string) => `${day.replaceAll("-", "")}.json`;
const status = (value: string) => LABELS[value] ?? value;
function rowTitle(row: LedgerRow) {
  const data = row.data;
  if (row.type === "position") return `${display(data.name)} · ${display(data.code)}`;
  if (row.type === "trade") return `${display(data.side)} · ${display(data.quantity)} 股`;
  if (row.type === "cash") return `${display(data.kind)} · ${display(data.amount)} ${display(data.currency)}`;
  if (row.type === "orderFile") return display(data.filename);
  if (row.type === "statement") return `${display(data.provider)} · ${display(data.external_account)}.xml`;
  if (row.type === "financialImport" || row.type === "historyImport") return `${status(row.type)}.json`;
  return status(row.type);
}

async function ownRequest(ownerId: string, path: string, signal: AbortSignal) {
  const response = await fetch(`${ROOT}${path}`, { signal, cache: "no-store", headers: { "X-Alcor-Expected-Account": ownerId } });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(typeof value?.error === "string" ? value.error : "读取失败，请重试");
  }
  return response;
}

function Values({ data }: { data: Data }) {
  return <dl className={styles.values}>{Object.entries(data).filter(([key]) => key !== "owner_id").map(([key, value]) =>
    <div key={key}><dt>{FIELDS[key] ?? key}</dt><dd>{typeof value === "object" && value !== null ? <pre>{display(value)}</pre> : display(value)}</dd></div>,
  )}</dl>;
}

function Evidence({ title, children }: { title: string; children: ReactNode }) {
  return <details className={styles.evidence}><summary><IconChevronRight size={14} />{title}</summary>{children}</details>;
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|\b(true|false|null)\b/gi;

function jsonTokens(source: string) {
  let at = 0;
  const parts: ReactNode[] = [];
  for (const token of source.matchAll(JSON_TOKEN)) {
    parts.push(source.slice(at, token.index));
    const color = token[2] ? styles.jsonKey : token[1] ? styles.jsonString : styles.jsonLiteral;
    parts.push(<span key={token.index} className={color}>{token[0]}</span>);
    at = token.index + token[0].length;
  }
  parts.push(source.slice(at));
  return parts;
}

function displayJson(source: string, limit: number) {
  // Only change whitespace outside strings. Parsing and reserializing through JS
  // could round integers in an otherwise valid original.
  let text = "", depth = 0, quoted = false, escape = false, lines = 1, index = 0;
  const newline = () => {
    text += "\n" + "  ".repeat(Math.min(depth, 48));
    lines++;
  };
  for (; index < source.length && lines <= limit && text.length < limit * 250; index++) {
    const char = source[index];
    if (quoted) {
      text += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      text += char;
    } else if (char === "{" || char === "[") {
      text += char;
      if (source[index + 1] === (char === "{" ? "}" : "]")) {
        text += source[++index];
        continue;
      }
      depth++;
      newline();
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      newline();
      text += char;
    } else if (char === ",") {
      text += char;
      newline();
    } else if (char === ":") {
      text += ": ";
    } else if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") {
      text += char;
    }
  }
  return { text, more: index < source.length };
}

function JsonPreview({ source, format = false }: { source: string; format?: boolean }) {
  const [limit, setLimit] = useState(120);
  const [copied, setCopied] = useState(false);
  const excerpt = useMemo(() => {
    if (format) return displayJson(source, limit);
    const text = source.slice(0, limit * 250).split("\n").slice(0, limit).join("\n");
    return { text, more: text.length < source.length };
  }, [format, limit, source]);
  const tokens = useMemo(() => jsonTokens(excerpt.text), [excerpt.text]);
  return <div className={styles.jsonPreview}>
    <div className={styles.codeToolbar}>
      <span>JSON</span>
      <button type="button" className={styles.link} onClick={() => void copyText(source).then(setCopied)}><IconCopy size={15} aria-hidden="true" />{copied ? "已复制" : "复制 JSON"}</button>
    </div>
    <pre tabIndex={0} aria-label="JSON 文件内容">{tokens}</pre>
    {excerpt.more && <div className={styles.codeFooter}><button type="button" className={styles.link} onClick={() => setLimit(limit + 120)}>继续查看</button></div>}
  </div>;
}

function sheetRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length && rows.length < 50; index++) {
    const char = text[index];
    if (char === '"' && (quoted || field === "")) {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(field); field = "";
    } else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      rows.push([...row, field]); row = []; field = "";
    } else field += char;
  }
  if (rows.length < 50 && (row.length || field)) rows.push([...row, field]);
  return rows;
}

function OriginalPreview({ ownerId, detail, file }: { ownerId: string; detail: LedgerDetail; file: OriginalFile }) {
  const [state, setState] = useState<{ format: string; text: string; url: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    const query = new URLSearchParams({ type: detail.type, id: detail.id });
    void ownRequest(ownerId, `/original?${query}`, controller.signal).then(async (response) => {
      const format = response.headers.get("x-alcor-file-format") ?? "download";
      const blob = await response.blob();
      const text = ["text", "json", "csv"].includes(format) ? await blob.text() : "";
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(format === "pdf" ? new Blob([blob], { type: "application/pdf" }) : blob);
      setState({ format, text, url });
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [ownerId, detail.type, detail.id]);
  if (error) return <p className={styles.notice} role="alert">{error}</p>;
  if (!state) return <p className={styles.notice} role="status">正在读取原件…</p>;
  const keys = [...new Set(file.rows?.flatMap(Object.keys) ?? [])];
  const rows = state.format === "csv" ? sheetRows(state.text, file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",")
    : file.rows?.length ? [keys, ...file.rows.map((row) => keys.map((key) => display(row[key])))] : [];
  return <div className={styles.originalFile}>
    <div className={styles.originalActions}>
      <a className={styles.link} download={file.name} href={state.url}>下载原件</a>
      {state.format === "pdf" && <a className={styles.link} href={state.url} target="_blank" rel="noopener noreferrer">在浏览器查看 PDF</a>}
    </div>
    {state.format === "json" && <JsonPreview source={state.text} />}
    {state.format === "text" && <pre className={styles.originalText}>{state.text}</pre>}
    {["csv", "xlsx"].includes(state.format) && rows.length > 0 && <div className={styles.sheet} tabIndex={0}>
      <table><thead><tr>{rows[0].map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
    </div>}
    {state.format === "download" && <p className={styles.notice}>可下载后使用对应应用打开</p>}
  </div>;
}

function amountTone(pnl: string) {
  return Number(pnl) > 0 ? "text-up" : Number(pnl) < 0 ? "text-down" : "";
}

function DailySnapshot({ result }: { result: DailyDetail }) {
  return <div className={styles.result}>
    <div className={styles.resultPrimary}>
      <span>日终盈亏</span>
      <strong className={result.pnl == null ? styles.incomplete : amountTone(result.pnl)}>{result.pnl ?? status(result.state)}</strong>
      {result.pnl != null && <small>{result.currency}</small>}
    </div>
    <dl>{[["日终净值", result.equity], ["前一日净值", result.priorEquity], ["当日净入金", result.externalFlow]].map(([label, value]) =>
      <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>,
    )}</dl>
  </div>;
}

function DailyEvidence({ result, choose }: { result: DailyDetail; choose: (item: Selection) => void }) {
  const previous = new Date(`${result.day}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return <>
    {result.missing.length > 0 && <section className={styles.gaps}><h4>待补依据</h4><ul>{result.missing.map((item, index) =>
      <li key={index}>{REASONS[item.reason] ?? item.reason}{item.currency ? ` · ${display(item.currency)}` : ""}{typeof item.recordId === "string" && <button type="button" onClick={() => choose({ type: "position", id: String(item.recordId) })}>查看持仓</button>}</li>,
    )}</ul></section>}
    <Evidence title={`持仓与收盘价 · ${result.positions.length}`}>
      {result.positions.map(({ recordId, close, ...position }) => <Evidence key={recordId} title={`${display(position.name)} · ${display(position.code)}`}>
        <button type="button" className={styles.link} onClick={() => choose({ type: "position", id: recordId,
          revision: typeof position.recordRevision === "number" ? position.recordRevision : undefined })}>打开持仓记录</button>
        <Values data={{ recordId, ...position }} />{close && <Values data={close} />}
      </Evidence>)}
    </Evidence>
    <Evidence title={`资金依据 · 当日 ${result.cashPostings.length} 笔`}>
      <Values data={{ "原币余额": result.cashByCurrency, "原币净入金": result.externalFlowByCurrency,
        "累计流水条数": result.cashPostingCount, "当日流水 SHA-256": result.cashPostingsSha256 }} />
      {result.cashPostings.map((posting) => <button type="button" key={posting.id} className={styles.link}
        onClick={() => choose({ type: "cash", id: posting.id })}>{display(posting.kind)} · {display(posting.amount)} {display(posting.currency)}</button>)}
      {result.cashOpenings.length > 0 && <Evidence title="现金期初依据">{result.cashOpenings.map((opening) => <Values key={String(opening.opening_request_id)} data={opening} />)}</Evidence>}
    </Evidence>
    <Evidence title="日终汇率">{Object.entries(result.fx).map(([currency, rate]) => <Evidence key={currency} title={currency}><Values data={rate} /></Evidence>)}</Evidence>
    <Evidence title="计算口径与版本">
      <Values data={{ "盈亏计算": "日终净值 − 前一日净值 − 当日净入金", "估值截点（UTC）": result.cutoff,
        "保存时间": result.capturedAt, "计算版本": result.rule, "输入 SHA-256": result.inputSha256 }} />
      {result.priorRevision != null && <button type="button" className={styles.link} onClick={() => choose({ day: previous.toISOString().slice(0, 10), revision: result.priorRevision! })}>前一日净值依据</button>}
    </Evidence>
  </>;
}

type Preview = { name: string; timestamp: string; counts: [string, number][]; digestChecked: boolean };
async function previewArchive(file: File, ownerId: string): Promise<Preview> {
  if (file.size > 128 * 1024 * 1024) throw new Error("档案超过 128 MiB");
  const source = await file.text();
  const value = JSON.parse(source);
  const manifest = value?.manifest;
  if (manifest?.format !== "alcor-personal-ledger" || manifest.version !== 1 || !value.tables || !manifest.counts)
    throw new Error("请选择完整个人账本档案");
  if (manifest.ownerId !== ownerId) throw new Error("档案属于另一个账户");
  const tables = Object.entries(value.tables);
  if (tables.length !== Object.keys(manifest.counts).length || tables.some(([key, rows]) => !Array.isArray(rows) ||
      manifest.counts[key] !== rows.length || rows.some((row) => row?.owner_id !== ownerId))) throw new Error("档案记录与清单不一致");
  let digestChecked = false;
  if (globalThis.crypto?.subtle) {
    const start = '{"tables":';
    const end = source.lastIndexOf(',"manifest":');
    if (!source.startsWith(start) || end < 0) throw new Error("档案原文与清单不一致");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.slice(start.length, end)));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (fingerprint !== manifest.tablesSha256) throw new Error("档案校验失败，文件内容已变化");
    digestChecked = true;
  }
  return { name: file.name, timestamp: manifest.exportedAt, digestChecked, counts: [
    ["持仓", manifest.counts.portfolio_records ?? 0], ["成交", manifest.counts.trade_ledger ?? 0],
    ["资金流水", manifest.counts.cash_ledger_entries ?? 0], ["成交更正", manifest.counts.trade_amendments ?? 0],
    ["费用更正", manifest.counts.trade_fee_corrections ?? 0], ["日终快照版本", manifest.counts.portfolio_daily_results ?? 0],
  ] };
}

export default function InvestmentDataManager({ ownerId }: { ownerId: string }) {
  const [folder, setFolder] = useState<Folder>("daily");
  const [year, setYear] = useState<number>();
  const [month, setMonth] = useState<number>();
  const [kind, setKind] = useState("real");
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<Cursor>(null);
  const [page, setPage] = useState<Cursor>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [file, setDetail] = useState<FileDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [view, setView] = useState<"file" | "json" | "sources">("file");
  const [previous, setPrevious] = useState<Selection[]>([]);
  const [exporting, setExporting] = useState(false);
  const [fileStatus, setFileStatus] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const exportRequest = useRef<AbortController | null>(null);

  useEffect(() => () => exportRequest.current?.abort(), []);
  useEffect(() => {
    if (folder === "archive") return;
    const controller = new AbortController();
    const daily = folder === "daily";
    const params = new URLSearchParams(daily ? { kind } : { section: folder });
    if (daily) {
      if (month === undefined) params.set("folders", "true");
      if (year !== undefined) params.set("year", String(year));
      if (month !== undefined) params.set("month", String(month));
    }
    if (typeof page === "string") params.set("before", page);
    if (Array.isArray(page)) {
      params.set("beforeAt", page[0]); params.set("beforeType", page[1]); params.set("beforeId", page[2]);
    }
    setLoading(true); setListError("");
    void ownRequest(ownerId, `${daily ? "/daily-results" : "/records"}?${params}`, controller.signal)
      .then((response) => response.json()).then((value) => {
        if (controller.signal.aborted) return;
        setRows((current) => page ? [...current, ...value.items] : value.items);
        setNext(value.next);
      }).catch((error) => { if (!controller.signal.aborted) setListError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [folder, kind, month, ownerId, page, refresh, year]);

  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    const daily = "day" in selection;
    const params = new URLSearchParams(daily ? { kind, day: selection.day, revision: String(selection.revision) }
      : { type: selection.type, id: selection.id });
    if (!daily && selection.revision !== undefined) params.set("revision", String(selection.revision));
    setDetail(null); setDetailError("");
    void ownRequest(ownerId, `${daily ? "/daily-results" : "/records"}?${params}`, controller.signal)
      .then((response) => response.text()).then((source) => {
        if (!controller.signal.aborted) setDetail({ data: JSON.parse(source), source });
      })
      .catch((error) => { if (!controller.signal.aborted) setDetailError(error.message); });
    return () => controller.abort();
  }, [kind, ownerId, selection]);

  function reset(nextFolder: Folder, nextYear?: number, nextMonth?: number) {
    setFolder(nextFolder); setYear(nextYear); setMonth(nextMonth); setRows([]); setPage(null); setNext(null); setSelection(null); setPrevious([]); setListError("");
    setLoading(nextFolder !== "archive");
  }
  function choose(item: Selection) {
    if (selection) setPrevious((current) => [...current, selection]);
    setView("file"); setDetail(null); setDetailError(""); setSelection(item);
  }
  async function download() {
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller; setExporting(true); setFileStatus("");
    try {
      const response = await ownRequest(ownerId, "/ledger", controller.signal);
      const bytes = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(bytes);
      const link = document.createElement("a");
      link.href = url; link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "Alcor-ledger.json";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 5_000);
      setFileStatus("完整账本已下载");
    } catch (error) {
      if (!controller.signal.aborted) setFileStatus(error instanceof Error ? error.message : "导出失败");
    } finally {
      exportRequest.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  const detail = file?.data;
  const snapshot = detail && "day" in detail ? detail : null;
  const original = detail && "type" in detail ? detail.file : undefined;
  const fileTitle = original?.name ?? (selection && ("day" in selection ? dailyFilename(selection.day)
    : selection.filename ?? (detail ? `${status(selection.type)}.json` : status(selection.type))));
  const dailyFolder = folder === "daily" && month === undefined;
  const dailyFiles = folder === "daily" && month !== undefined;
  const currentVersion = detail && ("day" in detail ? detail.revision : detail.version?.revision);
  const empty = folder === "daily" ? "暂无已保存的日终快照" : "暂无记录";

  return <div className={styles.workspace}>
    <div className={styles.layout}>
    <nav className={styles.categories} aria-label="投资数据分类">
      {FOLDERS.map(({ key, title, icon: Icon }) => <button key={key} type="button" aria-pressed={folder === key}
        onClick={() => { if (folder !== key) reset(key); }}><Icon size={17} stroke={1.7} aria-hidden="true" />{title}</button>)}
    </nav>
    <section className={styles.browser} aria-label={FOLDERS.find(({ key }) => key === folder)?.title}>
    {folder === "archive" ? <div className={styles.archive}>
      <div className={styles.archiveAction}>
        <IconArchive size={22} stroke={1.5} aria-hidden="true" />
        <div><strong>完整个人账本</strong><p>持仓、成交、资金流水、更正和日终快照</p></div>
        <Capsule size="sm" variant="secondary" busy={exporting} onClick={() => void download()}><IconDownload size={15} />下载 JSON</Capsule>
      </div>
      <div className={styles.archiveAction}>
        <IconHistory size={22} stroke={1.5} aria-hidden="true" />
        <div><strong>恢复前校验</strong><p>核对账户归属、记录条数和文件校验值</p></div>
        <label className={styles.filePicker}>选择文件<input type="file" aria-label="选择恢复文件" accept=".json,application/json" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setPreview(null);
          setFileStatus("正在核对…");
          void previewArchive(file, ownerId).then((value) => { setPreview(value); setFileStatus(""); })
            .catch((error) => setFileStatus(error instanceof SyntaxError ? "无法读取账本 JSON" : error.message));
        }} /></label>
      </div>
      {fileStatus && <p className={styles.notice} role="status">{fileStatus}</p>}
      {preview && <div className={styles.archivePreview}><strong>{preview.name}</strong><Values data={{ "导出时间": preview.timestamp,
        "文件校验": preview.digestChecked ? "SHA-256 已核对" : "当前连接可核对清单，SHA-256 待验证", ...Object.fromEntries(preview.counts) }} /></div>}
    </div> : <>
      {folder === "daily" && <div className={styles.toolbar}>
        <nav aria-label="每日盈亏目录" className={styles.breadcrumb}>
          {year === undefined ? <span aria-current="page">全部年份</span> : <button type="button" onClick={() => reset("daily")}>全部年份</button>}
          {year !== undefined && <><IconChevronRight size={13} aria-hidden="true" />
            {month === undefined ? <span aria-current="page">{year} 年</span> : <button type="button" onClick={() => reset("daily", year)}>{year} 年</button>}
          </>}
          {month !== undefined && <><IconChevronRight size={13} aria-hidden="true" /><span aria-current="page">{month} 月</span></>}
        </nav>
        <AppSelect ariaLabel="账户类型" value={kind} options={[{ value: "real", label: "真实账户" }, { value: "simulated", label: "模拟账户" }]}
          onChange={(value) => { if (value !== kind) { reset("daily"); setKind(value); } }} />
      </div>}
      <div className={styles.fileList} aria-label={dailyFolder ? "盈亏文件夹" : "资料列表"}>
        <div className={styles.listHead} aria-hidden="true">
          <span>{dailyFolder ? "文件夹" : dailyFiles ? "日期" : "文件"}</span>
          <span>{dailyFolder ? "已记录天数" : dailyFiles ? "日终盈亏" : "记录日期"}</span><span />
        </div>
        {rows.map((row) => {
          if ("year" in row) {
            const label = row.month === undefined ? `${row.year} 年` : `${row.month} 月`;
            return <button type="button" className={styles.listRow} key={`${row.year}:${row.month ?? 0}`}
              onClick={() => reset("daily", row.year, row.month)}>
              <span className={styles.fileName}><IconFolder size={21} stroke={1.65} aria-hidden="true" />{label}</span>
              <span className={styles.secondary}>{row.count} 天</span><IconChevronRight size={16} aria-hidden="true" />
            </button>;
          }
          const daily = "day" in row;
          const title = daily ? dailyFilename(row.day) : folder === "originals" ? rowTitle(row) : `${rowTitle(row)}.json`;
          const item: Selection = daily ? { day: row.day, revision: row.revision } :
            { type: row.type, id: row.id, filename: folder === "originals" ? title : undefined };
          return <button type="button" className={styles.listRow} key={daily ? row.day : `${row.type}:${row.id}`} aria-haspopup="dialog"
            onClick={() => { setPrevious([]); setView("file"); setDetail(null); setDetailError(""); setSelection(item); }}>
            <span className={styles.fileName}><IconFileDescription size={19} stroke={1.65} aria-hidden="true" />{title}</span>
            {daily ? <span className={styles.amount}>{row.pnl === null ? <small>{status(row.state)}</small> : <><b className={amountTone(row.pnl)}>{row.pnl}</b> <small>{row.currency}</small></>}</span>
              : <span className={styles.secondary}>{datePart(row.at)}</span>}
            <IconChevronRight size={16} aria-hidden="true" />
          </button>;
        })}
        {listError ? <div className={styles.notice} role="alert">{listError} <Capsule size="sm" variant="ghost" onClick={() => setRefresh(refresh + 1)}>重试</Capsule></div>
          : loading ? <p className={styles.notice} role="status">读取中…</p> : !rows.length ? <p className={styles.empty}><IconFolder size={22} stroke={1.5} aria-hidden="true" />{empty}</p> : null}
        {next && !loading && !listError && <div className={styles.loadMore}><Capsule size="sm" variant="ghost" onClick={() => setPage(next)}>加载更多</Capsule></div>}
      </div>
    </>}
    </section>
    </div>
    {selection && <AppModal title={fileTitle ?? "文件预览"} size="xl" className={styles.previewDialog}
      titleAddon={currentVersion && !(snapshot && snapshot.revisions.length > 1) ? <span className={styles.version}>第 {currentVersion} 版</span> : undefined}
      headerActions={previous.length > 0 ? <Capsule size="sm" variant="ghost" onClick={() => {
        setView("file"); setDetail(null); setDetailError("");
        setSelection(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1));
      }}>返回上一条</Capsule> : undefined}
      onClose={() => { setSelection(null); setDetail(null); setPrevious([]); }}>
      {detailError ? <p className={styles.notice} role="alert">{detailError}</p> : !file || !detail ? <p className={styles.notice} role="status">读取文件…</p> : <>
        <div className={styles.previewToolbar}>
        <nav className={styles.previewNav} aria-label="文件视图">
          <button type="button" aria-pressed={view === "file"} onClick={() => setView("file")}>{original ? "原始文件" : "文件内容"}</button>
          {original && <button type="button" aria-pressed={view === "json"} onClick={() => setView("json")}>记录 JSON</button>}
          <button type="button" aria-pressed={view === "sources"} onClick={() => setView("sources")}>数据依据</button>
        </nav>
        {snapshot && snapshot.revisions.length > 1 && <AppSelect ariaLabel="日终快照版本"
          value={String(snapshot.revision)} options={snapshot.revisions.map((number) => ({ value: String(number), label: `第 ${number} 版` }))}
          onChange={(value) => {
            const revision = Number(value);
            if (revision === snapshot.revision) return;
            setDetail(null);
            setDetailError("");
            setSelection({ day: snapshot.day, revision });
          }} />}
        </div>
        {snapshot && <DailySnapshot result={snapshot} />}
        {(view === "json" || view === "file" && !original) && <JsonPreview key={"day" in detail ? `${detail.day}:${detail.revision}` : `${detail.id}:${detail.version?.revision ?? "current"}`} source={file.source} format />}
        {view === "file" && original && "type" in detail && <OriginalPreview key={detail.id} ownerId={ownerId} detail={detail} file={original} />}
        {view === "sources" && ("day" in detail ? <DailyEvidence result={detail} choose={choose} /> : <Values data={{ "记录编号": detail.id, ...detail.data }} />)}
        {!("day" in detail) && detail.links.length > 0 && <Evidence title="关联记录">{detail.links.map((link, index) => <button type="button" className={styles.link}
          key={`${link.type}:${link.id}:${index}`} onClick={() => choose(link)}>{status(link.type)} · {link.id}</button>)}</Evidence>}
        {!("day" in detail) && detail.versions && detail.versions.length > 1 && <Evidence title="持仓版本">{detail.versions.map((version) => <button type="button" className={styles.link}
          disabled={version.revision === detail.version?.revision} key={version.revision} onClick={() => choose({ type: detail.type, id: detail.id, revision: version.revision })}>第 {version.revision} 版{version.action === "baseline" ? " · 首次留存" : ""}</button>)}</Evidence>}
      </>}
    </AppModal>}
  </div>;
}
