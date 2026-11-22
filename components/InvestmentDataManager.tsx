"use client";

import { IconArchive, IconArrowsExchange, IconBriefcase, IconChartLine, IconChevronLeft, IconChevronRight, IconCopy, IconFileDescription, IconFolder, IconDownload, IconHistory, IconReceipt, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AppSelect from "@/components/AppSelect";
import { Capsule } from "@/components/Capsule";
import { copyText } from "@/lib/clipboard";
import { MARKET_BADGE_ITEMS } from "@/lib/marketBadge";
import { useWorkspaceActive } from "@/lib/workspacePanel";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { useInvestmentDirectoryPages } from "@/lib/useInvestmentDirectoryPages";
import styles from "./InvestmentDataManager.module.css";

const ROOT = "/api/personal-data-transfer";
const FOLDERS = [
  { key: "daily", title: "每日盈亏", icon: IconChartLine },
  { key: "positions", title: "持仓", icon: IconBriefcase },
  { key: "trades", title: "成交与订单", icon: IconReceipt },
  { key: "funds", title: "资金流水", icon: IconArrowsExchange },
  { key: "corrections", title: "更正记录", icon: IconHistory },
  { key: "originals", title: "来源原件", icon: IconFileDescription },
  { key: "archive", title: "账本与备份", icon: IconArchive },
] as const;
type Folder = typeof FOLDERS[number]["key"];
type AccountKind = "real" | "simulated";
type DailyPath = { year?: number; month?: number };
type Data = Record<string, unknown>;
type LedgerRow = { type: string; id: string; at: string; data: Data };
type DailyRow = { day: string; revision: number; state: string; pnl: string | null; currency: string };
type PeriodFolder = { year: number; month?: number; count: number };
type MarketFolder = { market: string; count: number };
type Row = LedgerRow | DailyRow | PeriodFolder | MarketFolder;
type Cursor = [string, string, string] | string | null;
type DirectoryPage = { items: Row[]; next: Cursor };
const OTHER_LISTS = FOLDERS.filter(({ key }) => key !== "daily" && key !== "archive").map(({ key }) => key);
const FIRST_PAGE = { index: 0, starts: [null] as Cursor[] };
const MARKET_NAMES = new Map([...MARKET_BADGE_ITEMS.map(({ key, name }) => [key, name] as const),
  ["CN", "A 股"], ["ASSET", "其他资产"], ["brokers", "券商"]]);
const marketName = (market: string) => MARKET_NAMES.get(market) ?? market;

function directoryPath(folder: Folder, kind: AccountKind, { year, month }: DailyPath, cursor: Cursor, market?: string) {
  if (folder === "archive") return null;
  const daily = folder === "daily";
  const params = new URLSearchParams(daily ? { kind } : { section: folder });
  if (daily) {
    if (month === undefined) params.set("folders", "true");
    if (year !== undefined) params.set("year", String(year));
    if (month !== undefined) params.set("month", String(month));
  }
  if (folder === "positions") {
    if (market === undefined) params.set("groupBy", "market");
    else params.set("market", market);
  }
  if (typeof cursor === "string") params.set("before", cursor);
  if (Array.isArray(cursor)) {
    params.set("beforeAt", cursor[0]); params.set("beforeType", cursor[1]); params.set("beforeId", cursor[2]);
  }
  return `${daily ? "/daily-results" : "/records"}?${params}`;
}
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
type Selection = { day: string; revision: number } | { type: string; id: string; revision?: number; filename?: string };
type FileView = "file" | "json" | "sources";
type FileDetail = { selection: Selection; kind: AccountKind; data: DailyDetail | LedgerDetail; source: string };

const LABELS: Record<string, string> = {
  position: "持仓", trade: "成交", appFill: "App 成交", appOrder: "App 订单", declaration: "历史订单",
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
    throw Object.assign(new Error(typeof value?.error === "string" ? value.error : "读取失败，请重试"), { status: response.status });
  }
  return response;
}

function Values({ data }: { data: Data }) {
  return <dl className={styles.values}>{Object.entries(data).filter(([key]) => key !== "owner_id").map(([key, value]) =>
    <div key={key}><dt>{FIELDS[key] ?? key}</dt><dd>{typeof value === "object" && value !== null ? <pre>{display(value)}</pre> : display(value)}</dd></div>,
  )}</dl>;
}

function Evidence({ title, children }: { title: string; children: ReactNode }) {
  return <details className={styles.evidence}><summary><IconChevronRight size={14} aria-hidden="true" />{title}</summary>{children}</details>;
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

const SHEET_PREVIEW_ROWS = 50;

function sheetRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, hasField = false;
  // One extra record detects truncation without counting every row.
  for (let index = 0; index < text.length && rows.length <= SHEET_PREVIEW_ROWS + 1; index++) {
    const char = text[index];
    if (char === '"' && (quoted || !hasField)) {
      hasField = true;
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(field); field = ""; hasField = false;
    } else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      rows.push([...row, field]); row = []; field = ""; hasField = false;
    } else {
      field += char;
      hasField = true;
    }
  }
  if (row.length || hasField) rows.push([...row, field]);
  return rows;
}

function ReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className={styles.readError}>
    <p role="alert">{message}</p>
    <Capsule size="sm" variant="secondary" onClick={onRetry}>重试</Capsule>
  </div>;
}

function OriginalPreview({ ownerId, detail, file }: { ownerId: string; detail: LedgerDetail; file: OriginalFile }) {
  const [state, setState] = useState<{ format: string; text: string; url: string }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
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
  }, [ownerId, detail.type, detail.id, attempt]);
  if (error) return <ReadError message={error} onRetry={() => { setError(""); setAttempt((value) => value + 1); }} />;
  if (!state) return <p className={styles.notice} role="status">正在读取原件…</p>;
  const keys = [...new Set(file.rows?.flatMap(Object.keys) ?? [])];
  const rows = state.format === "csv" ? sheetRows(state.text, file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",")
    : file.rows?.length ? [keys, ...file.rows.map((row) => keys.map((key) => display(row[key])))] : [];
  const bounded = rows.length > SHEET_PREVIEW_ROWS + 1
    || (state.format === "xlsx" && rows.length === SHEET_PREVIEW_ROWS + 1);
  return <div className={styles.originalFile}>
    <div className={styles.originalActions}>
      <a className={styles.link} download={file.name} href={state.url}>下载原件</a>
      {state.format === "pdf" && <a className={styles.link} href={state.url} target="_blank" rel="noopener noreferrer">在浏览器查看 PDF</a>}
    </div>
    {state.format === "json" && <JsonPreview source={state.text} />}
    {state.format === "text" && <pre className={styles.originalText}>{state.text}</pre>}
    {["csv", "xlsx"].includes(state.format) && (rows.length > 0 ? <>
      {bounded && <p className={styles.sheetLimit}>显示前 {SHEET_PREVIEW_ROWS} 行</p>}
      <div className={styles.sheet} tabIndex={0} role="region" aria-label="表格原件预览">
        <table><thead><tr>{rows[0].map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
          <tbody>{rows.slice(1, SHEET_PREVIEW_ROWS + 1).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
      </div>
    </> : <p className={styles.notice}>暂无可预览的表格内容</p>)}
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
    <Evidence title="日终汇率">
      {Object.entries(result.fx).map(([currency, rate]) => <details className={styles.rate} key={currency}>
        <summary>
          <IconChevronRight size={13} aria-hidden="true" />
          <strong>{currency}</strong>
          <span className={styles.rateValue}>{display(rate.rate)}</span>
          <span className={styles.rateDate}>{display(rate.observationDay ?? rate.basis)}</span>
        </summary>
        <Values data={rate} />
      </details>)}
    </Evidence>
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

export function InvestmentArchiveAction({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children: ReactNode }) {
  return <div className={styles.archiveAction}>
    <span className={styles.archiveIcon} aria-hidden="true">{icon}</span>
    <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
    <div>{children}</div>
  </div>;
}

export default function InvestmentDataManager({ ownerId, archiveActions, resumeBackup }: { ownerId: string; archiveActions?: ReactNode; resumeBackup?: boolean }) {
  const workspaceActive = useWorkspaceActive();
  const foreground = useWorkspaceForeground();
  const [folder, setFolder] = useState<Folder>(resumeBackup ? "archive" : "daily");
  const [kind, setKind] = useState<AccountKind>("real");
  const [dailyPaths, setDailyPaths] = useState<Record<AccountKind, DailyPath>>({ real: {}, simulated: {} });
  const { year, month } = dailyPaths[kind];
  const [positionMarket, setPositionMarket] = useState<string>();
  const [pagination, setPagination] = useState(FIRST_PAGE);
  const resetPage = useCallback(() => setPagination(FIRST_PAGE), []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [file, setDetail] = useState<FileDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [view, setView] = useState<FileView>("file");
  const [previous, setPrevious] = useState<{ selection: Selection; view: FileView }[]>([]);
  const [exporting, setExporting] = useState(false);
  const [fileStatus, setFileStatus] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const previewContent = useRef<HTMLDivElement>(null);
  const previewTitle = useRef<HTMLHeadingElement>(null);
  const openedBy = useRef<HTMLButtonElement>(null);
  const listItems = useRef<HTMLDivElement>(null);
  const path = directoryPath(folder, kind, { year, month }, pagination.starts[pagination.index] ?? null, positionMarket);
  const readDirectory = useCallback(async (key: string, signal: AbortSignal): Promise<DirectoryPage> => {
    const response = await ownRequest(ownerId, key, signal);
    return response.json();
  }, [ownerId]);
  const { page, accessBlocked, error: listError, recheck, preload } = useInvestmentDirectoryPages({ path, foreground, read: readDirectory, resetPage });
  const next = page?.next;
  const loading = !page && !listError;
  const showPagination = pagination.index > 0 || pagination.starts.length > 1 || !!next;
  const showFile = workspaceActive && !accessBlocked && !!selection;

  useLayoutEffect(() => { listItems.current?.scrollTo(0, 0); }, [path]);
  useLayoutEffect(() => {
    if (showFile) previewTitle.current?.focus();
    else if (openedBy.current?.getClientRects().length) openedBy.current.focus({ preventScroll: true });
  }, [showFile]);
  useEffect(() => {
    if (!accessBlocked) return;
    setSelection(null);
    setDetail(null);
    setPrevious([]);
  }, [accessBlocked]);

  useEffect(() => () => exportRequest.current?.abort(), []);
  useEffect(() => {
    if (!foreground || !page || listError) return;
    const targets = [next ? directoryPath(folder, kind, { year, month }, next, positionMarket) : null];
    if (folder === "positions" && positionMarket === undefined) {
      for (const entry of page.items.slice(0, 3)) if ("market" in entry) targets.push(directoryPath("positions", kind, {}, null, entry.market));
    }
    targets.push(...OTHER_LISTS.map(other => directoryPath(other, kind, {}, null)));
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        for (const target of targets) {
          if (!active) return;
          if (!target || target === path) continue;
          try { await preload(target); } catch { return; }
        }
      })();
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [folder, foreground, kind, listError, month, next, page, path, positionMarket, preload, year]);

  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    const daily = "day" in selection;
    const params = new URLSearchParams(daily ? { kind, day: selection.day, revision: String(selection.revision) }
      : { type: selection.type, id: selection.id });
    if (!daily && selection.revision !== undefined) params.set("revision", String(selection.revision));
    void ownRequest(ownerId, `${daily ? "/daily-results" : "/records"}?${params}`, controller.signal)
      .then((response) => response.text()).then((source) => {
        if (!controller.signal.aborted) setDetail({ selection, kind, data: JSON.parse(source), source });
      })
      .catch((error) => { if (!controller.signal.aborted) setDetailError(error.message); });
    return () => controller.abort();
  }, [kind, ownerId, selection]);

  function closeFile() {
    setSelection(null);
    setDetail(null);
    setPrevious([]);
  }
  function resetList(nextFolder: Folder) {
    openedBy.current = null;
    setFolder(nextFolder);
    resetPage();
    closeFile();
  }
  function openMarket(market?: string) {
    setPositionMarket(market);
    resetList("positions");
  }
  function nextPage() {
    if (!next) return;
    setPagination(({ index, starts }) => ({ index: index + 1, starts: [...starts.slice(0, index + 1), next] }));
  }
  function openPeriod(nextYear?: number, nextMonth?: number) {
    setDailyPaths((paths) => ({ ...paths, [kind]: { year: nextYear, month: nextMonth } }));
    resetList("daily");
  }
  function showView(nextView: FileView) {
    setView(nextView);
    previewContent.current?.scrollTo(0, 0);
  }
  function readFile(item: Selection, nextView: FileView) {
    setDetailError("");
    setSelection({ ...item });
    showView(nextView);
  }
  function choose(item: Selection) {
    if (selection) setPrevious((current) => [...current, { selection, view }]);
    readFile(item, "file");
  }
  function returnToSource() {
    const source = previous.at(-1);
    if (!source) return;
    setPrevious(previous.slice(0, -1));
    readFile(source.selection, source.view);
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

  const activeFile = file?.selection === selection && file.kind === kind ? file : null;
  const detail = activeFile?.data;
  const dailySelection = selection && "day" in selection ? selection : null;
  const snapshot = detail && "day" in detail ? detail : null;
  const dailyVersions = dailySelection && file?.kind === kind && "day" in file.data && file.data.day === dailySelection.day
    ? file.data.revisions : [];
  const original = detail && "type" in detail ? detail.file : undefined;
  const fileTitle = original?.name ?? (selection && ("day" in selection ? dailyFilename(selection.day)
    : selection.filename ?? (detail ? `${status(selection.type)}.json` : status(selection.type))));
  const dailyFolder = folder === "daily" && month === undefined;
  const dailyFiles = folder === "daily" && month !== undefined;
  const marketFolders = folder === "positions" && positionMarket === undefined;
  const folderTitle = FOLDERS.find(({ key }) => key === folder)?.title;
  const currentVersion = dailySelection?.revision ?? (detail && "type" in detail ? detail.version?.revision : undefined);
  const empty = folder === "daily" ? "暂无已保存的日终快照" : "暂无记录";

  return <div className={styles.workspace}>
    <div className={styles.layout}>
    <nav className={styles.categories} aria-label="投资数据分类">
      {FOLDERS.map(({ key, title, icon: Icon }) => <button key={key} type="button" aria-pressed={folder === key}
        onClick={() => { if (folder !== key) resetList(key); }}><Icon size={17} stroke={1.7} aria-hidden="true" />{title}</button>)}
    </nav>
    <section className={styles.browser} aria-label={folderTitle}>
    <div className={styles.browserHeader}>
      <h2>{folderTitle}</h2>
      {folder !== "archive" && <Capsule size="sm" variant="ghost" aria-label="重新读取列表" title="重新读取列表" disabled={loading} onClick={recheck}>
        <IconRefresh size={16} aria-hidden="true" />
      </Capsule>}
    </div>
    {folder === "archive" ? <div className={styles.archive}>
      <InvestmentArchiveAction icon={<IconArchive size={18} />} title="完整个人账本" description="持仓、成交、资金流水、更正和日终快照。">
        <Capsule size="sm" variant="secondary" busy={exporting} onClick={() => void download()}><IconDownload size={15} />下载 JSON</Capsule>
      </InvestmentArchiveAction>
      <InvestmentArchiveAction icon={<IconHistory size={18} />} title="恢复前校验" description="核对账户归属、记录条数和文件校验值。">
        <label className={styles.filePicker}>选择文件<input type="file" aria-label="选择恢复文件" accept=".json,application/json" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setPreview(null);
          setFileStatus("正在核对…");
          void previewArchive(file, ownerId).then((value) => { setPreview(value); setFileStatus(""); })
            .catch((error) => setFileStatus(error instanceof SyntaxError ? "无法读取账本 JSON" : error.message));
        }} /></label>
      </InvestmentArchiveAction>
      {fileStatus && <p className={styles.notice} role="status">{fileStatus}</p>}
      {preview && <div className={styles.archivePreview}><strong>{preview.name}</strong><Values data={{ "导出时间": preview.timestamp,
        "文件校验": preview.digestChecked ? "SHA-256 已核对" : "当前连接可核对清单，SHA-256 待验证", ...Object.fromEntries(preview.counts) }} /></div>}
      {archiveActions}
    </div> : <div hidden={showFile}>
      {folder === "daily" && <div className={styles.toolbar}>
        <nav aria-label="每日盈亏目录" className={styles.breadcrumb}>
          {year === undefined ? <span aria-current="page">全部年份</span> : <button type="button" onClick={() => openPeriod()}>全部年份</button>}
          {year !== undefined && <><IconChevronRight size={13} aria-hidden="true" />
            {month === undefined ? <span aria-current="page">{year} 年</span> : <button type="button" onClick={() => openPeriod(year)}>{year} 年</button>}
          </>}
          {month !== undefined && <><IconChevronRight size={13} aria-hidden="true" /><span aria-current="page">{month} 月</span></>}
        </nav>
        <AppSelect ariaLabel="账户类型" value={kind} options={[{ value: "real", label: "真实账户" }, { value: "simulated", label: "模拟账户" }]}
          onChange={(value) => {
            if ((value === "real" || value === "simulated") && value !== kind) {
              setKind(value);
              resetList("daily");
            }
          }} />
      </div>}
      {folder === "positions" && <nav className={styles.marketPath} aria-label="持仓市场目录">
        {marketFolders ? <span aria-current="page">全部市场</span> : <>
          <button type="button" onClick={() => openMarket()}>全部市场</button><IconChevronRight size={13} aria-hidden="true" />
          <span aria-current="page">{marketName(positionMarket ?? "")}</span>
        </>}
      </nav>}
      <div className={styles.fileList} aria-label={dailyFolder ? "盈亏文件夹" : marketFolders ? "市场文件夹" : "资料列表"} aria-busy={loading || undefined}>
        <div className={styles.listHead} aria-hidden="true">
          <span>{dailyFolder || marketFolders ? "文件夹" : dailyFiles ? "日期" : "文件"}</span>
          <span>{marketFolders ? "文件数" : dailyFolder ? "已记录天数" : dailyFiles ? "日终盈亏" : "记录日期"}</span><span />
        </div>
        <div ref={listItems} className={showPagination ? styles.pagedRows : undefined}>
        {page?.items.map((row) => {
          if ("year" in row || "market" in row) {
            const market = "market" in row;
            const label = market ? marketName(row.market) : row.month === undefined ? `${row.year} 年` : `${row.month} 月`;
            return <button type="button" className={styles.listRow} key={market ? row.market : `${row.year}:${row.month ?? 0}`}
              onClick={() => market ? openMarket(row.market) : openPeriod(row.year, row.month)}>
              <span className={styles.fileName}><IconFolder size={21} stroke={1.65} aria-hidden="true" />{label}</span>
              <span className={styles.secondary}>{row.count} {market ? "项" : "天"}</span><IconChevronRight size={16} aria-hidden="true" />
            </button>;
          }
          const daily = "day" in row;
          const title = daily ? dailyFilename(row.day) : folder === "originals" ? rowTitle(row) : `${rowTitle(row)}.json`;
          const item: Selection = daily ? { day: row.day, revision: row.revision } :
            { type: row.type, id: row.id, filename: title };
          return <button type="button" className={styles.listRow} key={daily ? row.day : `${row.type}:${row.id}`} aria-controls="investment-file-preview"
            onClick={(event) => { openedBy.current = event.currentTarget; setPrevious([]); readFile(item, "file"); }}>
            <span className={styles.fileName}><IconFileDescription size={19} stroke={1.65} aria-hidden="true" />{title}</span>
            {daily ? <span className={styles.amount}>{row.pnl === null ? <small>{status(row.state)}</small> : <><b className={amountTone(row.pnl)}>{row.pnl}</b> <small>{row.currency}</small></>}</span>
              : <span className={styles.secondary}>{datePart(row.at)}</span>}
            <IconChevronRight size={16} aria-hidden="true" />
          </button>;
        })}
        </div>
        {listError ? <ReadError message={listError} onRetry={recheck} /> : loading ? (
          <div className={styles.placeholder} role="status" aria-label="正在读取文件列表"><i /><i /><i /></div>
        ) : !page?.items.length ? <p className={styles.empty}><IconFolder size={22} stroke={1.5} aria-hidden="true" />{empty}</p> : null}
        {showPagination && <nav className={styles.pageNav} aria-label="文件列表分页">
          <Capsule size="sm" variant="ghost" aria-label="上一页" disabled={pagination.index === 0}
            onClick={() => setPagination(state => ({ ...state, index: state.index - 1 }))}><IconChevronLeft size={17} aria-hidden="true" /></Capsule>
          <span aria-current="page" aria-live="polite">第 {pagination.index + 1} 页</span>
          <Capsule size="sm" variant="ghost" aria-label="下一页" disabled={!next} onClick={nextPage}><IconChevronRight size={17} aria-hidden="true" /></Capsule>
        </nav>}
      </div>
    </div>}
    <section id="investment-file-preview" aria-label="文件预览" hidden={!showFile} className={styles.filePreview}>
    {showFile && selection && <>
      <div className={styles.fileHeader}>
        <Capsule size="sm" variant="ghost" onClick={closeFile}><IconChevronLeft size={16} aria-hidden="true" />返回列表</Capsule>
        {previous.length > 0 && <Capsule size="sm" variant="ghost" onClick={returnToSource}>返回上一条</Capsule>}
      </div>
      <h3 className={styles.fileTitle} ref={previewTitle} tabIndex={-1}>
        {fileTitle ?? "文件预览"}
        {currentVersion && dailyVersions.length <= 1 ? <span className={styles.version}>第 {currentVersion} 版</span> : null}
      </h3>
      <div ref={previewContent} className={dailySelection ? styles.snapshotContent : undefined}>
        {(dailySelection || detail) && <div className={styles.previewToolbar}>
          <nav className={styles.previewNav} aria-label="文件视图">
            <button type="button" aria-pressed={view === "file"} onClick={() => showView("file")}>{original ? "原始文件" : "文件内容"}</button>
            {original && <button type="button" aria-pressed={view === "json"} onClick={() => showView("json")}>记录 JSON</button>}
            <button type="button" aria-pressed={view === "sources"} onClick={() => showView("sources")}>数据依据</button>
          </nav>
          {dailySelection && dailyVersions.length > 1 && <AppSelect ariaLabel="日终快照版本"
            value={String(dailySelection.revision)} options={dailyVersions.map((number) => ({ value: String(number), label: `第 ${number} 版` }))}
            onChange={(value) => {
              const revision = Number(value);
              if (revision !== dailySelection.revision) readFile({ day: dailySelection.day, revision }, view);
            }} />}
        </div>}
        {detailError ? <ReadError message={detailError} onRetry={() => readFile(selection, view)} /> :
          !activeFile || !detail ? <p className={styles.notice} role="status">读取文件…</p> : <>
            {snapshot && <DailySnapshot result={snapshot} />}
            {(view === "json" || view === "file" && !original) && <JsonPreview key={"day" in detail ? `${detail.day}:${detail.revision}` : `${detail.id}:${detail.version?.revision ?? "current"}`} source={activeFile.source} format />}
            {view === "file" && original && "type" in detail && <OriginalPreview key={detail.id} ownerId={ownerId} detail={detail} file={original} />}
            {view === "sources" && ("day" in detail ? <DailyEvidence result={detail} choose={choose} /> : <Values data={{ "记录编号": detail.id, ...detail.data }} />)}
            {!("day" in detail) && detail.links.length > 0 && <Evidence title="关联记录">{detail.links.map((link, index) => <button type="button" className={styles.link}
              key={`${link.type}:${link.id}:${index}`} onClick={() => choose(link)}>{status(link.type)} · {link.id}</button>)}</Evidence>}
            {!("day" in detail) && detail.versions && detail.versions.length > 1 && <Evidence title="持仓版本">{detail.versions.map((version) => <button type="button" className={styles.link}
              disabled={version.revision === detail.version?.revision} key={version.revision} onClick={() => choose({ type: detail.type, id: detail.id, revision: version.revision })}>第 {version.revision} 版{version.action === "baseline" ? " · 首次留存" : ""}</button>)}</Evidence>}
          </>}
      </div>
    </>}
    </section>
    </section>
    </div>
  </div>;
}
