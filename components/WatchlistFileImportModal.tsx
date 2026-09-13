"use client";

import { useRef, useState } from "react";
import AppModal from "@/components/AppModal";
import type { WatchGroup } from "@/lib/watchGroups";
import { showToast } from "@/lib/toast";

import { parseStockFile, type FileImportRow as ImportRow } from "@/lib/importFile";

export default function WatchlistFileImportModal({ groups, initialGroupId, onClose, onBack, onImported }: { groups: WatchGroup[]; initialGroupId: string; onClose: () => void; onBack?: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function readFile(file?: File) {
    if (!file) return;
    setRows([]);
    setFileName("");
    setError("");
    try {
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buffer);
      // 部分券商导出的 TXT/SEL/EBK 仍使用 GBK；UTF-8 解码出现乱码时自动回退。
      if (text.includes("�")) text = new TextDecoder("gb18030").decode(buffer);
      const parsed = parseStockFile(text);
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

  return <AppModal title="导入股票" onClose={onClose} size="xl" className="!max-w-[1180px]">
    {onBack && <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 rounded-full bg-bg-gray px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97]">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg>
      返回编辑分组
    </button>}
    <div className="grid grid-cols-1 md:h-[min(650px,calc(100dvh-190px))] md:min-h-0 md:overflow-hidden rounded-2xl border border-edge md:grid-cols-[270px_minmax(0,1fr)_250px]">
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
          <li>1. 支持 TXT、CSV、JSON，以及文本格式的 SEL、EBK 文件。</li>
          <li>2. 请确保文件每行仅有一只股票。</li>
          <li>3. 可多次导入，已存在的股票不会重复添加，单次最多 2000 只。</li>
        </ol>
      </section>
      <section className="flex min-h-0 min-w-0 flex-col p-5">
        <div className="mb-3 flex items-center justify-between"><div><h4 className="text-base font-bold text-ink">待导入列表 ({rows.length})</h4><p className="mt-1 text-xs text-muted">将加入全部自选{groupId ? "及右侧选择的分组" : ""}</p></div></div>
        <div className="max-h-[280px] min-h-0 flex-1 overflow-auto md:max-h-none rounded-xl border border-edge">
          <table className="w-full min-w-[480px] text-sm"><thead className="sticky top-0 bg-bg-gray text-xs text-muted"><tr><th className="px-4 py-3 text-left">代码</th><th className="px-3 py-3 text-left">名称</th><th className="px-4 py-3 text-left">市场</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.market}:${row.code}:${index}`} className="border-t border-edge"><td className="px-4 py-3 font-semibold">{row.code}</td><td className="px-3 py-3">{row.name}</td><td className="px-4 py-3 text-muted">{row.market}</td></tr>)}</tbody></table>
          {!rows.length && <div className="grid min-h-[120px] place-items-center text-sm text-faint">暂无数据</div>}
        </div>
      </section>
      <section className="watch-import-target flex min-h-0 flex-col border-t border-edge p-5 md:border-l md:border-t-0">
        <h4 className="text-base font-bold text-ink">选择分组</h4>
        <div className="mt-4 max-h-[220px] min-h-0 flex-1 space-y-1 overflow-y-auto md:max-h-none">
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
