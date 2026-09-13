"use client";

import { useRef, useState } from "react";
import AppModal from "@/components/AppModal";
import type { WatchGroup } from "@/lib/watchGroups";
import { showToast } from "@/lib/toast";

interface ImportRow { code: string; name: string; market: string }

function normalizeMarket(value: string, code: string) {
  const raw = value.trim().toUpperCase();
  if (/港|HK/.test(raw)) return "HK";
  if (/美|US|NASDAQ|NYSE/.test(raw)) return "US";
  if (/新加坡|SG/.test(raw)) return "SG";
  if (/日|JP/.test(raw)) return "JP";
  if (/韩|KR/.test(raw)) return "KR";
  if (/A股|沪|深|CN|SH|SZ/.test(raw)) return "CN";
  return /^\d{5}$/.test(code) ? "HK" : /^[A-Z][A-Z0-9._-]*$/.test(code) ? "US" : "CN";
}

function parseText(text: string): ImportRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
      return items.map((item: Record<string, unknown>) => {
        const code = String(item.code ?? item.symbol ?? "").trim();
        return { code, name: String(item.name ?? item.title ?? code).trim(), market: normalizeMarket(String(item.market ?? ""), code) };
      }).filter((row: ImportRow) => row.code);
    } catch { return []; }
  }
  return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.includes("\t") ? line.split("\t") : line.includes(",") ? line.split(",") : line.split(/\s{2,}|\s+/);
    const clean = parts.map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const code = clean[0]?.replace(/^(US|HK|SH|SZ)[.:]?/i, "") ?? "";
    return { code, name: clean[1] || code, market: normalizeMarket(clean[2] || "", code) };
  }).filter((row) => row.code && !/^(代码|code|symbol)$/i.test(row.code));
}

export default function WatchlistFileImportModal({ groups, initialGroupId, onClose, onImported }: { groups: WatchGroup[]; initialGroupId: string; onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buffer);
      // 部分券商导出的 TXT/SEL/EBK 仍使用 GBK；UTF-8 解码出现乱码时自动回退。
      if (text.includes("�")) text = new TextDecoder("gb18030").decode(buffer);
      const parsed = parseText(text).slice(0, 2000);
      if (!parsed.length) throw new Error("未识别到股票，请检查文件内容");
      setRows(parsed);
      setFileName(file.name);
    } catch (err) { setError(err instanceof Error ? err.message : "读取文件失败"); }
  }

  async function apply() {
    if (!rows.length) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/records/import-apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, ...(groupId ? { groupId } : {}) }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "导入失败");
      showToast(`已导入 ${Number(data.added) + Number(data.updated)} 只股票`, "ok");
      onImported();
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "导入失败"); } finally { setBusy(false); }
  }

  return <AppModal title="导入股票" onClose={onClose} size="xl" className="!max-w-[1180px] !overflow-hidden">
    <div className="grid h-[min(650px,calc(100vh-150px))] min-h-[460px] grid-cols-1 overflow-hidden rounded-2xl border border-edge md:grid-cols-[270px_minmax(0,1fr)_250px]">
      <section className="watch-import-source border-b border-edge p-5 md:border-b-0 md:border-r">
        <h4 className="text-base font-bold text-ink">选择导入文件</h4>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="btn btn-line mt-4 h-11 w-full shrink-0 px-5 text-sm leading-none"
        >
          选择文件
        </button>
        <input ref={fileRef} type="file" accept=".txt,.csv,.sel,.ebk,.json,text/plain,text/csv,application/json" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
        {fileName && <p className="mt-2 truncate text-xs text-muted">{fileName}</p>}
        <ol className="mt-5 space-y-4 text-xs leading-6 text-muted">
          <li>1. 支持 TXT、CSV、SEL、EBK 与 JSON 文件。</li>
          <li>2. 请确保文件每行仅有一只股票。</li>
          <li>3. 可多次导入，已存在的股票不会重复添加，单次最多 2000 只。</li>
        </ol>
      </section>
      <section className="flex min-w-0 flex-col p-5">
        <div className="mb-3 flex items-center justify-between"><div><h4 className="text-base font-bold text-ink">待导入列表 ({rows.length})</h4><p className="mt-1 text-xs text-muted">将加入全部自选{groupId ? "及右侧选择的分组" : ""}</p></div></div>
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-edge">
          <table className="w-full min-w-[480px] text-sm"><thead className="sticky top-0 bg-bg-gray text-xs text-muted"><tr><th className="px-4 py-3 text-left">代码</th><th className="px-3 py-3 text-left">名称</th><th className="px-4 py-3 text-left">市场</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.market}:${row.code}:${index}`} className="border-t border-edge"><td className="px-4 py-3 font-semibold">{row.code}</td><td className="px-3 py-3">{row.name}</td><td className="px-4 py-3 text-muted">{row.market}</td></tr>)}</tbody></table>
          {!rows.length && <div className="grid h-full min-h-[320px] place-items-center text-sm text-faint">暂无数据</div>}
        </div>
      </section>
      <section className="watch-import-target flex min-h-0 flex-col border-t border-edge p-5 md:border-l md:border-t-0">
        <h4 className="text-base font-bold text-ink">选择分组</h4>
        <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
          <label className="flex items-center gap-3 rounded-xl bg-bg-gray px-3 py-3 text-sm font-semibold"><input type="checkbox" checked disabled />全部</label>
          {groups.filter((group) => group.kind === "custom").map((group) => <label key={group.id} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm ${groupId === group.id ? "bg-bg-gray font-semibold text-ink" : "text-muted hover:bg-brand-hover hover:text-ink"}`}><input type="checkbox" checked={groupId === group.id} onChange={() => setGroupId((current) => current === group.id ? "" : group.id)} />{group.name}</label>)}
        </div>
        {error && <p className="mt-3 text-xs text-down">{error}</p>}
        <div className="mt-4 flex gap-2 border-t border-edge pt-4">
          <button type="button" onClick={onClose} className="btn btn-ghost h-10 flex-1 px-4 text-sm leading-none">取消</button>
          <button type="button" disabled={!rows.length || busy} onClick={() => void apply()} className="btn btn-line h-10 flex-1 px-4 text-sm leading-none disabled:opacity-40">{busy ? "导入中…" : "导入"}</button>
        </div>
      </section>
    </div>
  </AppModal>;
}
