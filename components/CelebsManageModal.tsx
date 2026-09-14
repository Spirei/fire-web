"use client";

import { useEffect, useRef, useState } from "react";
import { showToast } from "@/lib/toast";
import { useAssetIcons } from "@/lib/useAssetIcons";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import AppSelect from "@/components/AppSelect";

interface ManageCeleb {
  id: string;
  name: string;
  title: string;
  avatar: string;
  enabled: boolean;
  sort: number;
  sourceKind: "13f" | "form4" | "none";
  cik: string;
  entity: string;
  sourceLabel: string;
  holdings: {
    code: string;
    name: string;
    market: string;
    weight: number;
    price: number;
    changePct: number;
    target: number;
  }[];
  trades: { code: string; name: string; changePct: number; action: string }[];
  returns: { y1: number; y3: number; y5: number; spxY1: number; points: number[]; spxPoints: number[]; benchmarks?: { code: string; name: string; y1: number; points: number[] }[] };
  stockIcons: Record<string, string>;
  refreshHours: number;
}

interface Draft extends ManageCeleb {}

const SOURCE_OPTIONS = [
  { key: "none", label: "示例数据（手动维护）" },
  { key: "13f", label: "SEC EDGAR 13F（机构季报）" },
  { key: "form4", label: "SEC EDGAR Form 4（董监高变动）" }
] as const;

const inputCls =
  "h-[34px] rounded-[9px] border border-edge-strong bg-white px-2.5 text-[13px] text-ink outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]";

/* 管理列表本地缓存：再次打开秒出，不再闪现「加载中」 */
const MANAGE_CACHE_KEY = "fire:celebs:manage";
function loadManageCache(): ManageCeleb[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MANAGE_CACHE_KEY) || "[]") as ManageCeleb[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveManageCache(list: ManageCeleb[]) {
  try {
    localStorage.setItem(MANAGE_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* 忽略存储失败 */
  }
}

function SourceBadge({ kind }: { kind: ManageCeleb["sourceKind"] }) {
  const m: Record<string, string> = {
    "13f": "bg-bg-gray text-muted dark:bg-white/10 dark:text-[#c9cdd6]",
    form4: "bg-bg-gray text-muted dark:bg-white/10 dark:text-[#c9cdd6]",
    none: "bg-bg-gray text-muted dark:bg-white/5 dark:text-[#aab2c0]"
  };
  const label = SOURCE_OPTIONS.find((o) => o.key === kind)?.label ?? "示例数据";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${m[kind]}`}>{label}</span>;
}

function emptyDraft(id = ""): Draft {
  return {
    id,
    name: "",
    title: "",
    avatar: "",
    enabled: true,
    sort: 0,
    sourceKind: "none",
    cik: "",
    entity: "",
    sourceLabel: "",
    holdings: [],
    trades: [],
    returns: { y1: 0, y3: 0, y5: 0, spxY1: 0, points: [0], spxPoints: [0], benchmarks: [] },
    stockIcons: {},
    refreshHours: 0
  };
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[20px] w-[36px] flex-none rounded-full transition-colors duration-300 ease-out disabled:opacity-50 ${
        checked ? "bg-[#34c759]" : "bg-[#e9e9eb] dark:bg-[#3a3a3c]"
      }`}
      title={checked ? "点击停用" : "点击启用"}
    >
      <span
        className={`absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform duration-300 ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
        style={{ backgroundColor: "#ffffff", transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }}
      />
    </button>
  );
}

export default function CelebsManageModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [celebs, setCelebs] = useState<ManageCeleb[]>(() => loadManageCache());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const avatarRef = useRef<HTMLInputElement | null>(null);
  const [iconMeta, setIconMeta] = useState<{ code: string; market: string; name: string } | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);
  const { stockIcons: assetStockIcons } = useAssetIcons(["stock"]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/celebs/manage");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "读取失败");
      setCelebs(data.celebs ?? []);
      saveManageCache(data.celebs ?? []);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "读取名人失败", "err");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = loadManageCache();
    if (cached.length > 0) setCelebs(cached);
    void load();
  }, []);

  function patch(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function patchHolding(i: number, p: Partial<Draft["holdings"][number]>) {
    setDraft((d) =>
      d ? { ...d, holdings: d.holdings.map((h, idx) => (idx === i ? { ...h, ...p } : h)) } : d
    );
  }

  function patchTrade(i: number, p: Partial<Draft["trades"][number]>) {
    setDraft((d) =>
      d ? { ...d, trades: d.trades.map((t, idx) => (idx === i ? { ...t, ...p } : t)) } : d
    );
  }

  async function uploadAvatar(file: File) {
    if (!draft) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("id", draft.id || "temp");
      fd.append("file", file);
      const res = await fetch("/api/celebs/avatar", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      patch({ avatar: data.avatar });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传头像失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function uploadStockIcon(meta: { code: string; market: string; name: string }, file: File) {
    if (!draft) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("kind", "asset");
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      const key = meta.code.trim().toUpperCase();
      // 全局注册到素材库（市场:代码）：该股票在所有名人持仓 / 详情生效，避免重复上传
      const reg = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stock",
          market: meta.market || "US",
          code: key,
          name: meta.name,
          url: data.url
        })
      });
      const rdata = await reg.json().catch(() => null);
      if (!reg.ok) throw new Error(rdata?.error || "全局保存失败");
      // 刷新素材库缓存（表单与前台圆环立即生效；不再写名人专属记录，素材库为唯一图标源）
      window.dispatchEvent(new Event("fire:assets-updated"));
      showToast("图标已全局保存（该股票全站生效）", "ok");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传图标失败", "err");
    } finally {
      setBusy(false);
    }
  }

  function holdingIconUrl(code: string, market = "US"): string | undefined {
    if (!draft) return undefined;
    const key = code.trim().toUpperCase();
    return draft.stockIcons?.[key] || assetStockIcons[`${market}:${key}`] || assetStockIcons[`US:${key}`];
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      showToast("请填写名人名称", "err");
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...draft,
        id: draft.id.trim().toLowerCase() || undefined,
        holdings: draft.holdings.filter((h) => h.code.trim()),
        trades: draft.trades.filter((t) => t.code.trim()),
        stockIcons: draft.stockIcons,
        refreshHours: draft.refreshHours
      };
      const res = await fetch("/api/celebs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast("名人已保存", "ok");
      setDraft(null);
      await load();
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, body: Partial<Draft>) {
    setBusy(true);
    try {
      const res = await fetch("/api/celebs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, id })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast("已保存", "ok");
      await load();
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  /* 启用滑块：乐观更新，点击立即平滑切换，不整表刷新（避免页面抖动） */
  async function toggleEnabled(id: string, checked: boolean) {
    setCelebs((prev) => prev.map((c) => (c.id === id ? { ...c, enabled: checked } : c)));
    try {
      const res = await fetch("/api/celebs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: checked })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast(checked ? "已启用" : "已停用", "ok");
      onChanged();
    } catch (err) {
      // 失败回滚
      setCelebs((prev) => prev.map((c) => (c.id === id ? { ...c, enabled: !checked } : c)));
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    }
  }

  async function remove(id: string) {
    setConfirmDel(null);
    try {
      const res = await fetch(`/api/celebs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "删除失败");
      showToast("已删除", "ok");
      await load();
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "err");
    }
  }

  async function dropReorder(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = celebs.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    setCelebs(ids.map((id, i) => ({ ...celebs.find((c) => c.id === id)!, sort: i })));
    try {
      const res = await fetch("/api/celebs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reorder: ids })
      });
      if (!res.ok) throw new Error("排序保存失败");
      showToast("排序已保存", "ok");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "排序保存失败", "err");
      await load();
    }
  }

  const draftIdValid = /^[a-z0-9_-]+$/.test((draft?.id ?? "").trim()) && !!draft?.id.trim();
  const sourceDefaultHours = draft
    ? draft.id === "cathie"
      ? 24
      : draft.sourceKind === "13f"
        ? 168
        : draft.sourceKind === "form4"
          ? 24
          : 720
    : 24;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="名人管理">
      <div className="modal-scrim absolute inset-0 modal-overlay" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[860px] flex-col overflow-hidden rounded-[22px] border border-black/8 bg-white shadow-[0_24px_64px_rgba(0,0,0,.22)] dark:border-white/10 dark:bg-[#1c1c1e]"
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-edge px-6 py-4 dark:border-[#2a3140]">
          <div>
            <h3 className="text-[17px] font-bold text-ink">名人管理</h3>
            <p className="mt-0.5 text-[12px] text-muted">新增 / 编辑 / 排序名人，数据来源与持仓可维护，保存后前台立即生效</p>
          </div>
          <div className="flex items-center gap-2">
            {!draft && (
              <button
                type="button"
                onClick={() => setDraft(emptyDraft())}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#e4e7ea] px-3.5 py-2 text-xs font-semibold leading-none whitespace-nowrap text-[#3f4652] transition-all duration-200 hover:-translate-y-px hover:bg-[#d7dbe0] dark:bg-[#3b4354] dark:text-white dark:hover:bg-[#4a5568]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3.5 w-3.5">
                  <path d="M12 5v14" /><path d="M5 12h14" />
                </svg>
                新增名人
              </button>
            )}
            <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10" aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          {draft ? (
            <div className="space-y-5">
              {/* 股票图标上传（名人专属，不全局） */}
              <input
                ref={iconRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  const meta = iconMeta;
                  e.target.value = "";
                  setIconMeta(null);
                  if (f && meta) void uploadStockIcon(meta, f);
                }}
              />
              {/* 返回列表 */}
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                返回列表
              </button>

              {/* 基本信息 */}
              <section>
                <h4 className="mb-2.5 text-[13px] font-bold text-ink">基本信息</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">唯一标识 ID（英文，如 bill-gates）</span>
                    <input value={draft.id} disabled={!!celebs.find((c) => c.id === draft.id)} onChange={(e) => patch({ id: e.target.value })} placeholder="bill-gates" className={`${inputCls} w-full`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">名称 *</span>
                    <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="比尔·盖茨" className={`${inputCls} w-full`} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">头衔</span>
                    <input value={draft.title} onChange={(e) => patch({ title: e.target.value })} placeholder="微软联合创始人" className={`${inputCls} w-full`} />
                  </label>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    title="上传头像"
                    onClick={() => avatarRef.current?.click()}
                    className="group relative flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-full ring-1 ring-black/10 transition-all duration-300 hover:scale-110 hover:ring-2 hover:ring-[#9aa1ab] dark:ring-white/15"
                  >
                    {draft.avatar ? (
                      <img src={draft.avatar} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center bg-bg-gray text-lg font-bold text-muted transition-transform duration-300 group-hover:scale-110 dark:bg-white/10">?</span>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                        <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                        <circle cx="12" cy="13" r="3" />
                      </svg>
                    </span>
                  </button>
                  <input ref={avatarRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadAvatar(f); }} />
                </div>
              </section>

              {/* 数据来源 */}
              <section>
                <h4 className="mb-2.5 text-[13px] font-bold text-ink">数据来源</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">来源类型</span>
                    <AppSelect value={draft.sourceKind} onChange={(value) => patch({ sourceKind: value as Draft["sourceKind"] })} options={SOURCE_OPTIONS.map((option) => ({ value: option.key, label: option.label }))} className={`${inputCls} w-full`} ariaLabel="来源类型" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">SEC CIK（10 位，可留空自动反查）</span>
                    <input value={draft.cik} onChange={(e) => patch({ cik: e.target.value })} placeholder="0001067983" className={`${inputCls} w-full`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">申报主体（CIK 反查用）</span>
                    <input value={draft.entity} onChange={(e) => patch({ entity: e.target.value })} placeholder="Berkshire Hathaway" className={`${inputCls} w-full`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">来源标签（显示在卡片上）</span>
                    <input value={draft.sourceLabel} onChange={(e) => patch({ sourceLabel: e.target.value })} placeholder="SEC EDGAR 13F · 伯克希尔" className={`${inputCls} w-full`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-muted">数据有效期（小时，留空自动按来源类型）</span>
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      value={draft.refreshHours || ""}
                      onChange={(e) => patch({ refreshHours: Number(e.target.value) || 0 })}
                      placeholder={`自动（${sourceDefaultHours}h：13F 168h / Form 4·每日 24h / 手动 720h）`}
                      className={`${inputCls} w-full`}
                    />
                  </label>
                </div>
              </section>

              {/* 持仓明细 */}
              <section>
                <div className="mb-2.5 flex items-center justify-between">
                  <h4 className="text-[13px] font-bold text-ink">持仓明细（SEC 拉取成功后自动替换，示例 / 手动维护用这里）</h4>
                  <button type="button" onClick={() => patch({ holdings: [...draft.holdings, { code: "", name: "", market: "US", weight: 0, price: 0, changePct: 0, target: 0 }] })} className="btn btn-line px-3 py-1.5 text-xs">+ 添加持仓</button>
                </div>
                <div className="data-table-scroll">
                  <div className="mb-1.5 grid min-w-[680px] grid-cols-[2.2rem_1fr_1.2fr_0.9fr_0.8fr_0.8fr_2rem] items-center gap-2 px-0.5 text-center text-[11px] font-semibold text-muted">
                    <span>图标</span>
                    <span>股票代码</span>
                    <span>股票名称</span>
                    <span>市场</span>
                    <span>占比%</span>
                    <span>目标价</span>
                    <span />
                  </div>
                  <div className="min-w-[680px] space-y-2">
                  {draft.holdings.length === 0 && <p className="text-[12px] text-faint">暂无持仓，点击右上角添加</p>}
                  {draft.holdings.map((h, i) => (
                    <div key={i} className="grid grid-cols-[2.2rem_1fr_1.2fr_0.9fr_0.8fr_0.8fr_2rem] items-center gap-2">
                      {/* 股票图标：全局素材库生效（按市场:代码），无需每只股票重复上传 */}
                      <button
                        type="button"
                        title={`上传 ${h.code || "股票"} 图标（全站生效）`}
                        onClick={() => {
                          setIconMeta({ code: h.code.trim().toUpperCase(), market: (h.market || "US").toUpperCase(), name: h.name });
                          iconRef.current?.click();
                        }}
                        className="group relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full ring-1 ring-black/10 transition-all duration-300 hover:scale-110 hover:ring-2 hover:ring-brand/60 dark:ring-white/15"
                      >
                        {holdingIconUrl(h.code, h.market) ? (
                          <img src={holdingIconUrl(h.code, h.market)} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center bg-bg-gray text-[11px] font-bold text-muted transition-transform duration-300 group-hover:scale-110 dark:bg-white/10">
                            {(h.name || h.code || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                            <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                            <circle cx="12" cy="13" r="3" />
                          </svg>
                        </span>
                      </button>
                      <input value={h.code} onChange={(e) => patchHolding(i, { code: e.target.value })} placeholder="AAPL" className={`${inputCls} w-full`} />
                      <input value={h.name} onChange={(e) => patchHolding(i, { name: e.target.value })} placeholder="苹果" className={`${inputCls} w-full`} />
                      <span className="flex items-center justify-center gap-1.5">
                        <MarketIcon market={h.market} size={16} />
                        <input value={h.market} onChange={(e) => patchHolding(i, { market: e.target.value })} placeholder="US" className={`${inputCls} w-full min-w-0`} />
                      </span>
                      <input type="number" step="0.1" value={h.weight || ""} onChange={(e) => patchHolding(i, { weight: Number(e.target.value) })} placeholder="34.9" className={`${inputCls} w-full text-center`} />
                      <input type="number" step="0.01" value={h.target || ""} onChange={(e) => patchHolding(i, { target: Number(e.target.value) })} placeholder="—" className={`${inputCls} w-full text-center`} />
                      <button type="button" onClick={() => patch({ holdings: draft.holdings.filter((_, idx) => idx !== i) })} className="flex h-8 w-8 items-center justify-center rounded-[9px] text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white" title="删除">
                        <DeleteIcon size={14} />
                      </button>
                    </div>
                  ))}
                  </div>
                </div>
              </section>

              {/* 近期操作 */}
              <section>
                <div className="mb-2.5 flex items-center justify-between">
                  <h4 className="text-[13px] font-bold text-ink">近期操作（卡片左侧标签）</h4>
                  <button type="button" onClick={() => patch({ trades: [...draft.trades, { code: "", name: "", changePct: 0, action: "买入" }] })} className="btn btn-line px-3 py-1.5 text-xs">+ 添加操作</button>
                </div>
                <div className="data-table-scroll">
                  <div className="mb-1.5 grid min-w-[520px] grid-cols-[1fr_1.2fr_0.8fr_1fr_2rem] items-center gap-2 px-0.5 text-center text-[11px] font-semibold text-muted">
                    <span>股票代码</span>
                    <span>股票名称</span>
                    <span>涨跌幅%</span>
                    <span>操作</span>
                    <span />
                  </div>
                  <div className="min-w-[520px] space-y-2">
                  {draft.trades.map((t, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1.2fr_0.8fr_1fr_2rem] items-center gap-2">
                      <input value={t.code} onChange={(e) => patchTrade(i, { code: e.target.value })} placeholder="代码" className={`${inputCls} w-full`} />
                      <input value={t.name} onChange={(e) => patchTrade(i, { name: e.target.value })} placeholder="名称" className={`${inputCls} w-full`} />
                      <input type="number" step="0.01" value={t.changePct || ""} onChange={(e) => patchTrade(i, { changePct: Number(e.target.value) })} placeholder="涨跌%" className={`${inputCls} w-full`} />
                      <AppSelect value={t.action} onChange={(value) => patchTrade(i, { action: value })} options={["买入", "增仓", "建仓", "增持", "减仓", "卖出"].map((value) => ({ value, label: value }))} className={`${inputCls} w-full`} ariaLabel="交易动作" />
                      <button type="button" onClick={() => patch({ trades: draft.trades.filter((_, idx) => idx !== i) })} className="flex h-8 w-8 items-center justify-center rounded-[9px] text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white" title="删除">
                        <DeleteIcon size={14} />
                      </button>
                    </div>
                  ))}
                  </div>
                </div>
              </section>

              {/* 收益 */}
              <section>
                <h4 className="mb-2.5 text-[13px] font-bold text-ink">收益（近 1 / 3 / 5 年 %）</h4>
                <div className="grid grid-cols-3 gap-3">
                  {(["y1", "y3", "y5"] as const).map((k) => (
                    <label key={k} className="block">
                      <span className="mb-1 block text-[11px] font-semibold text-muted">{k === "y1" ? "近1年" : k === "y3" ? "近3年" : "近5年"}</span>
                      <input type="number" step="0.01" value={draft.returns[k] || ""} onChange={(e) => patch({ returns: { ...draft.returns, [k]: Number(e.target.value) } })} className={`${inputCls} w-full`} />
                    </label>
                  ))}
                </div>
              </section>

              {/* 底部操作 */}
              <div className="mt-5 flex justify-end gap-2.5 border-t border-edge pt-4 dark:border-[#2a3140]">
                <button type="button" onClick={() => setDraft(null)} className="btn btn-line px-4 py-2 text-xs">取消</button>
                {draft && !celebs.find((c) => c.id === draft.id) ? (
                  <button type="button" disabled={busy || !draftIdValid} onClick={save} className="btn btn-brand px-4 py-2 text-xs disabled:opacity-50">
                    {busy ? "保存中…" : "创建名人"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!draft) return;
                      void update(draft.id, {
                        name: draft.name,
                        title: draft.title,
                        avatar: draft.avatar,
                        enabled: draft.enabled,
                        sourceKind: draft.sourceKind,
                        cik: draft.cik,
                        entity: draft.entity,
                        sourceLabel: draft.sourceLabel,
                        holdings: draft.holdings.filter((h) => h.code.trim()),
                        trades: draft.trades.filter((t) => t.code.trim()),
                        returns: draft.returns,
                        stockIcons: draft.stockIcons,
                        refreshHours: draft.refreshHours
                      });
                    }}
                    className="btn btn-brand px-4 py-2 text-xs disabled:opacity-50"
                  >
                    {busy ? "保存中…" : "保存"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <p className="mb-3 text-[11px] text-faint">拖动左侧手柄排序，保存后前台立即生效</p>
              <div className="space-y-2">
                {loading && celebs.length === 0 ? (
                  <div className="space-y-2 py-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-11 animate-pulse rounded-[12px] bg-bg-gray/60 dark:bg-white/[0.05]" />
                    ))}
                  </div>
                ) : celebs.length === 0 ? (
                  <p className="py-8 text-center text-sm text-faint">还没有名人，点击右上角「新增名人」</p>
                ) : (
                  celebs.map((c) => (
                    <div
                      key={c.id}
                      draggable
                      onDragStart={() => setDragId(c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => void dropReorder(c.id)}
                      className={`flex items-center gap-3 rounded-[12px] border border-edge bg-bg-gray/40 px-3.5 py-2.5 transition-colors dark:bg-white/[0.04] ${dragId === c.id ? "opacity-50" : ""}`}
                    >
                      <span className="cursor-grab text-faint" title="拖动排序">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                          <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                          <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                          <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                        </svg>
                      </span>
                      <img src={c.avatar || undefined} alt="" className="h-9 w-9 flex-none rounded-full object-cover ring-1 ring-black/10 transition-transform duration-300 hover:scale-110 hover:ring-2 hover:ring-[#9aa1ab] dark:ring-white/15" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-bold text-ink">{c.name}</span>
                          <SourceBadge kind={c.sourceKind} />
                        </div>
                        <span className="block truncate text-[11px] text-faint">{c.title || c.id} · {c.holdings.length} 项持仓</span>
                      </div>
                      <div className="flex items-center">
                        <Toggle checked={c.enabled} onChange={(v) => void toggleEnabled(c.id, v)} />
                      </div>
                      <button type="button" onClick={() => setDraft({ ...c })} className="rounded-full p-2 text-faint transition-colors hover:bg-brand-hover hover:text-brand-deep dark:hover:bg-white/10 dark:hover:text-[#8ec2ff]" title="编辑">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        </svg>
                      </button>
                      {confirmDel === c.id ? (
                        <button type="button" onClick={() => void remove(c.id)} className="rounded-full bg-up px-2.5 py-1 text-[11px] font-semibold text-white">确认删除</button>
                      ) : (
                        <button type="button" onClick={() => setConfirmDel(c.id)} className="rounded-full p-2 text-faint transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white" title="删除">
                          <DeleteIcon size={14} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
