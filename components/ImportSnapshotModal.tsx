"use client";

import { useRef, useState } from "react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import { showToast } from "@/lib/toast";
import type { WatchGroup } from "@/lib/watchGroups";

interface PreviewRow {
  name: string;
  code: string;
  market: string;
  qty: number | null;
  price: number | null;
  cost: number | null;
  status: "new" | "update" | "skip";
  matched: boolean;
}

export default function ImportSnapshotModal({
  onClose,
  onImported,
  mode = "holdings",
  watchGroups = []
}: {
  onClose: () => void;
  onImported: (result: { added: number; updated: number; skipped: number }) => void;
  mode?: "holdings" | "watchlist";
  watchGroups?: WatchGroup[];
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"upload" | "working" | "preview">("upload");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [provider, setProvider] = useState("");
  const [groupId, setGroupId] = useState("");
  const isWatchlist = mode === "watchlist";

  async function handleFile(file: File | null) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setError("请选择图片文件（截图）");
      return;
    }
    setError("");
    setPhase("working");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/records/import-image", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "识别失败");
      if (!Array.isArray(data.rows) || data.rows.length === 0) {
        setError(`没有从截图中识别到股票，请换一张${isWatchlist ? "自选股/行情列表" : "持仓/行情列表"}截图`);
        setPhase("upload");
        return;
      }
      setRows(data.rows);
      setRaw(typeof data.raw === "string" ? data.raw : "");
      setProvider(typeof data.provider === "string" ? data.provider : "");
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "识别失败，请稍后重试");
      setPhase("upload");
    }
  }

  function patchRow(index: number, patch: Partial<PreviewRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function apply() {
    const valid = rows.filter((row) => row.name.trim() || row.code.trim());
    if (valid.length === 0) return;
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/records/import-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: valid.map((row) => ({
            name: row.name,
            code: row.code,
            market: row.market,
            qty: isWatchlist ? null : row.qty,
            price: isWatchlist ? null : row.price,
            cost: isWatchlist ? null : row.cost
          })),
          ...(isWatchlist && groupId ? { groupId } : {})
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "导入失败");
      showToast(`已导入 ${data.added + data.updated} 条（新增 ${data.added} · 更新 ${data.updated}）`);
      onImported({ added: Number(data.added) || 0, updated: Number(data.updated) || 0, skipped: Number(data.skipped) || 0 });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败，请稍后重试");
    } finally {
      setImporting(false);
    }
  }

  const editable = (row: PreviewRow, index: number, key: "name" | "code" | "market", value: string) => {
    return (
      <input
        value={value}
        onChange={(e) => patchRow(index, { [key]: e.target.value } as Partial<PreviewRow>)}
        className="field h-8 rounded-[8px] px-2 py-1 text-xs"
      />
    );
  };
  const num = (value: number | null) => (value === null ? "" : String(value));
  const numField = (row: PreviewRow, index: number, key: "qty" | "price" | "cost") => (
    <input
      type="number"
      min="0"
      step="any"
      value={num(row[key])}
      onChange={(e) => {
        const v = e.target.value === "" ? null : Number(e.target.value);
        patchRow(index, { [key]: v !== null && Number.isFinite(v) ? v : null });
      }}
      className="field h-8 rounded-[8px] px-2 py-1 text-right text-xs tabular-nums"
    />
  );

  return (
    <AppModal
      title={isWatchlist ? "截图导入自选股" : "截图导入持仓"}
      desc={phase === "preview" ? (isWatchlist ? "识别结果可编辑，确认后写入自选股" : "识别结果可编辑，确认后自动写入我的持仓") : (isWatchlist ? "上传行情列表截图，自动识别股票并同步到自选股" : "上传券商持仓或行情截图，自动识别股票并同步更新")}
      onClose={onClose}
      size="xl"
    >
      {phase === "upload" || phase === "working" ? (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={phase === "working"}
            className="flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-edge-strong bg-bg-gray/60 px-6 py-14 text-center transition-colors hover:border-[#3297f6] hover:bg-[#3297f6]/5 disabled:opacity-60"
          >
            {phase === "working" ? (
              <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-edge border-t-[#3297f6]" />
            ) : (
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#3297f6]/10 text-[#3297f6]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.2" /></svg>
              </span>
            )}
            <span className="text-sm font-semibold text-ink-2">{phase === "working" ? "正在识别截图…" : isWatchlist ? "点击上传自选股 / 行情截图" : "点击上传持仓 / 行情截图"}</span>
            <span className="max-w-[420px] text-xs leading-relaxed text-muted">{isWatchlist ? "支持 JPG / PNG / WEBP，自动识别股票名称、代码与市场；识别结果先预览、可编辑，确认后才写入自选股。" : "支持 JPG / PNG / WEBP，自动识别股票名称、代码、数量、现价与成本；识别结果先预览、可编辑，确认后才写入。"}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          />
          {error && <p className="rounded-[10px] bg-up-bg px-3.5 py-2.5 text-[13px] text-up">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} className="dialog-btn dialog-btn-ghost">取消</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-muted">识别到 {rows.filter((r) => r.status !== "skip").length} 条 · {provider === "deepseek" ? "DeepSeek 视觉识别" : provider === "apple-vision" ? "Apple Vision 本地识别" : "直接写入，无需手动输入"}</span>
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover" title="重新上传截图">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.2" /></svg>
              换一张
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {isWatchlist && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-bg-gray/45 px-3.5 py-3">
              <div>
                <p className="text-xs font-semibold text-ink-2">批量导入分组</p>
                <p className="mt-0.5 text-[11px] text-muted">可将本次识别的股票统一加入一个自定义分组</p>
              </div>
              <AppSelect value={groupId} onChange={setGroupId} options={[{ value: "", label: "不指定分组" }, ...watchGroups.filter((group) => group.kind === "custom").map((group) => ({ value: group.id, label: group.name }))]} className="field h-9 min-w-[170px] rounded-lg px-2.5 text-xs font-semibold" ariaLabel="批量导入分组" />
            </div>
          )}
          <div className="max-h-[46vh] overflow-auto rounded-2xl border border-edge">
            <table className="w-full min-w-[620px] text-xs">
              <thead className="sticky top-0 z-10 bg-bg-gray text-[11px] font-semibold text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">名称</th>
                  <th className="px-2 py-2.5 text-left">代码</th>
                  <th className="px-2 py-2.5 text-left">市场</th>
                  {!isWatchlist && <th className="px-2 py-2.5 text-right">数量</th>}
                  {!isWatchlist && <th className="px-2 py-2.5 text-right">现价</th>}
                  {!isWatchlist && <th className="px-2 py-2.5 text-right">成本</th>}
                  <th className="px-2 py-2.5 text-right">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className="border-t border-edge">
                    <td className="px-3 py-2">{editable(row, index, "name", row.name)}</td>
                    <td className="px-2 py-2">{editable(row, index, "code", row.code)}</td>
                    <td className="px-2 py-2">{editable(row, index, "market", row.market)}</td>
                    {!isWatchlist && <td className="px-2 py-2">{numField(row, index, "qty")}</td>}
                    {!isWatchlist && <td className="px-2 py-2">{numField(row, index, "price")}</td>}
                    {!isWatchlist && <td className="px-2 py-2">{numField(row, index, "cost")}</td>}
                    <td className="px-2 py-2 text-right">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.status === "update" ? "bg-down-bg text-down" : row.status === "skip" ? "bg-bg-gray text-faint" : "bg-[#fff4e5] text-[#b06a00]"}`}>
                        {row.status === "update" ? "更新" : row.status === "skip" ? "跳过" : "新增"}
                        {row.matched && <i className="h-1.5 w-1.5 rounded-full bg-[#9ACD32]" title="素材库已匹配" />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {raw && (
            <details className="rounded-xl border border-edge px-3.5 py-2 text-xs text-muted">
              <summary className="cursor-pointer select-none font-semibold text-ink-2">识别原文（模型输出）</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted">{raw}</pre>
            </details>
          )}
          {error && <p className="rounded-[10px] bg-up-bg px-3.5 py-2.5 text-[13px] text-up">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={importing} className="dialog-btn dialog-btn-ghost">取消</button>
            <button type="button" onClick={() => void apply()} disabled={importing} className="dialog-btn dialog-btn-neutral">{importing ? "导入中…" : `导入 ${rows.filter((r) => r.name.trim() || r.code.trim()).length} 条`}</button>
          </div>
        </div>
      )}
    </AppModal>
  );
}
