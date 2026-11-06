import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getDb } from "./db";

export type ReportFileKind = "original" | "parsed" | "export" | "filing";
export interface FinancialReportFile {
  id: string; market: string; exchange: string; companyCode: string; companyName: string;
  fiscalYear: number; fiscalPeriod: string; reportType: string; fileKind: ReportFileKind;
  fileName: string; fileUrl: string; mimeType: string; fileSize: number; source: string;
  schemaVersion: string; createdAt: string;
}

const SAFE_SEGMENT = /^[A-Z0-9._-]{1,40}$/;
export function safeSegment(value: string, label: string) {
  const normalized = value.trim().toUpperCase();
  if (!SAFE_SEGMENT.test(normalized) || normalized.includes("..")) throw new Error(`${label}格式不正确`);
  return normalized;
}

function fromRow(row: Record<string, unknown>): FinancialReportFile {
  return { id: String(row.id), market: String(row.market), exchange: String(row.exchange), companyCode: String(row.company_code), companyName: String(row.company_name || ""), fiscalYear: Number(row.fiscal_year), fiscalPeriod: String(row.fiscal_period), reportType: String(row.report_type || ""), fileKind: String(row.file_kind) as ReportFileKind, fileName: String(row.file_name), fileUrl: String(row.file_url), mimeType: String(row.mime_type || ""), fileSize: Number(row.file_size || 0), source: String(row.source || "manual"), schemaVersion: String(row.schema_version || "1.0"), createdAt: String(row.created_at) };
}

export function listFinancialReportFiles(filters: { market?: string; exchange?: string; code?: string }) {
  const clauses: string[] = []; const values: string[] = [];
  for (const [column, value] of [["market", filters.market], ["exchange", filters.exchange], ["company_code", filters.code]] as const) {
    if (value) { clauses.push(`${column} = ?`); values.push(value.trim().toUpperCase()); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (getDb().prepare(`SELECT * FROM financial_report_files ${where} ORDER BY fiscal_year DESC, fiscal_period DESC, created_at DESC`).all(...values) as Record<string, unknown>[]).map(fromRow);
}

export async function saveFinancialReportFile(input: { file: File; market: string; exchange: string; code: string; companyName: string; fiscalYear: number; fiscalPeriod: string; reportType: string; userId: string }) {
  const market = safeSegment(input.market, "市场"); const exchange = safeSegment(input.exchange, "交易所");
  const code = safeSegment(input.code, "股票代码"); const period = safeSegment(input.fiscalPeriod, "报告期");
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2200) throw new Error("财年格式不正确");
  const ext = path.extname(input.file.name).toLowerCase();
  const allowed: Record<string, { kind: ReportFileKind; mime: string }> = { ".pdf": { kind: "original", mime: "application/pdf" }, ".json": { kind: "parsed", mime: "application/json" }, ".csv": { kind: "export", mime: "text/csv" } };
  const config = allowed[ext]; if (!config) throw new Error("仅支持 PDF、JSON、CSV 财报文件");
  const max = ext === ".pdf" ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  if (!input.file.size || input.file.size > max) throw new Error(`文件大小不能超过 ${max / 1024 / 1024}MB`);
  const id = `fr-${randomBytes(10).toString("hex")}`; const safeName = `${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const relativeDir = path.join("uploads", "reports", market, exchange, code, String(input.fiscalYear), period);
  const diskDir = path.join(process.cwd(), "public", relativeDir); fs.mkdirSync(diskDir, { recursive: true });
  const diskPath = path.join(diskDir, safeName); fs.writeFileSync(diskPath, Buffer.from(await input.file.arrayBuffer()));
  const url = `/${path.join(relativeDir, safeName).split(path.sep).join("/")}`; const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO financial_report_files (id,market,exchange,company_code,company_name,fiscal_year,fiscal_period,report_type,file_kind,file_name,file_url,mime_type,file_size,source,schema_version,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'manual','1.0',?,?)`).run(id, market, exchange, code, input.companyName.trim(), input.fiscalYear, period, input.reportType.trim(), config.kind, path.basename(input.file.name), url, config.mime, input.file.size, input.userId, now);
  return fromRow(getDb().prepare("SELECT * FROM financial_report_files WHERE id = ?").get(id) as Record<string, unknown>);
}

export function deleteFinancialReportFile(id: string) {
  const row = getDb().prepare("SELECT file_url FROM financial_report_files WHERE id = ?").get(id) as { file_url?: string } | undefined;
  if (!row) return false;
  getDb().prepare("DELETE FROM financial_report_files WHERE id = ?").run(id);
  if (row.file_url?.startsWith("/uploads/reports/")) {
    const root = path.join(process.cwd(), "public", "uploads", "reports");
    const target = path.resolve(path.join(process.cwd(), "public", row.file_url));
    if (target.startsWith(`${path.resolve(root)}${path.sep}`)) fs.rmSync(target, { force: true });
  }
  return true;
}
