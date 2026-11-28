"use client";

import { IconBriefcase, IconDatabaseExport, IconDatabaseImport, IconShieldCheck } from "@tabler/icons-react";
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Capsule } from "@/components/Capsule";
import InvestmentDataManager, { InvestmentArchiveAction } from "@/components/InvestmentDataManager";
import MigrationReadinessCard from "@/components/MigrationReadinessCard";
import PlatformBackups from "@/components/PlatformBackups";
import { platformRequest } from "@/lib/platformRequest";
import { clientRequestId } from "@/lib/randomId";
import { usePersistedState } from "@/lib/usePersistedState";
import { useWorkspaceSearchParams } from "@/lib/workspacePanel";

const MIN_WIDTH = 680;
const WIDTH_STEP = 32;

type WidthDrag = { pointerId: number; startX: number; startWidth: number; multiplier: number; width: number };

type Counts = { records?: number; tradeOrders?: number; watchGroups?: number };
type ImportPlan = { requestId: string; previewId: string; state: string; confirmSupported: boolean; counts?: Counts; blocked?: unknown[] };

export default function DataManagementView({ ownerId, sessionCsrf, admin, recordsCount, onExport }: {
  ownerId: string;
  sessionCsrf: string;
  admin: boolean;
  recordsCount: number | null;
  onExport: () => void;
}) {
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [pending, setPending] = useState<{ name: string; plan: ImportPlan }>();
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const available = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<WidthDrag | null>(null);
  const [savedWidth, setSavedWidth] = usePersistedState<number | null>("fire:data-management:width", null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const width = draftWidth ?? savedWidth;
  const widthStyle = typeof width === "number" && Number.isFinite(width) && width >= MIN_WIDTH
    ? { "--data-management-width": `${width}px` } as CSSProperties : undefined;
  const importBackupRef = useRef<HTMLInputElement>(null);
  const importReviewId = useId();
  const params = useWorkspaceSearchParams();
  const resumeBackup = admin && /^[a-f0-9-]{36}$/i.test(params?.get("backupRequest") ?? "");
  const ownerHeaders = { "X-Alcor-Expected-Account": ownerId };

  function boundedWidth(value: number) {
    return Math.min(available.current?.clientWidth ?? MIN_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
  }

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    if (!frame.current || event.button !== 0) return;
    const width = Math.round(frame.current.getBoundingClientRect().width);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width,
      multiplier: document.documentElement.dataset.platformAlign === "center" ? 2 : 1 };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.width = boundedWidth(active.startWidth + (event.clientX - active.startX) * active.multiplier);
    setDraftWidth(active.width);
  }

  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.type === "pointerup" && active.width !== active.startWidth) setSavedWidth(active.width);
    setDraftWidth(null);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!frame.current) return;
    const width = frame.current.getBoundingClientRect().width;
    switch (event.key) {
      case "ArrowLeft": setSavedWidth(boundedWidth(width - WIDTH_STEP)); break;
      case "ArrowRight": setSavedWidth(boundedWidth(width + WIDTH_STEP)); break;
      case "End": setSavedWidth(available.current?.clientWidth ?? MIN_WIDTH); break;
      case "Home": setSavedWidth(null); break;
      default: return;
    }
    event.preventDefault();
  }

  async function exportSiteBackup() {
    setBackupBusy("export");
    setNotice(undefined);
    try {
      const res = await fetch("/api/v1/data/export", { cache: "no-store", headers: ownerHeaders });
      if (!res.ok) throw new Error("导出失败");
      const blob = await res.blob();
      const payload = JSON.parse(await blob.text());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `alcor-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const c = payload?.manifest?.counts;
      if (payload?.manifest?.portable === false) {
        setNotice({ message: "旧版文件仅含部分记录，完整记录请下载个人账本。" });
      } else {
        setNotice({ message: `已导出持仓 ${c?.records ?? 0} 条、订单 ${c?.tradeOrders ?? 0} 条。` });
      }
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : "导出失败", error: true });
    } finally {
      setBackupBusy(null);
    }
  }

  async function previewSiteBackup(file: File) {
    setNotice(undefined);
    setPending(undefined);
    if (file.size > 10 * 1024 * 1024) {
      setNotice({ message: "备份文件超过 10MB 限制", error: true });
      return;
    }
    setBackupBusy("import");
    try {
      const requestId = clientRequestId();
      const plan = await platformRequest<ImportPlan>("/api/v1/data/import?preview=1", {
        method: "POST", headers: { ...ownerHeaders, "Content-Type": "application/json", "X-Alcor-Request-Id": requestId }, body: await file.text(),
      });
      if (plan.state !== "previewed" || !plan.previewId || plan.requestId !== requestId) throw new Error("备份预览尚未确认");
      setPending({ name: file.name, plan });
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : "备份文件校验失败", error: true });
    } finally {
      setBackupBusy(null);
    }
  }

  async function confirmSiteBackup() {
    if (!pending?.plan.confirmSupported || backupBusy) return;
    const { requestId, previewId } = pending.plan;
    setBackupBusy("import");
    setNotice(undefined);
    try {
      const result = await platformRequest<{ requestId: string; executed: boolean; state: string }>("/api/personal-data-transfer/submit", {
        method: "POST", headers: { ...ownerHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ requestId, previewId }),
      });
      if (result.requestId !== requestId || result.state !== "completed" || !result.executed) throw new Error("导入结果尚未确认，可重试核对原请求");
      setPending(undefined);
      setNotice({ message: "已导入备份。" });
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:orders-updated"));
      window.dispatchEvent(new Event("fire:funds-updated"));
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : "导入结果尚未确认，可重试核对原请求", error: true });
    } finally {
      setBackupBusy(null);
    }
  }

  return (
    <section ref={available} className="data-management-page mx-auto w-full min-w-0 max-w-[1100px]" aria-labelledby="data-management-title">
      <div ref={frame} className="data-management-frame" style={widthStyle} data-resizing={draftWidth !== null || undefined}>
      <h1 id="data-management-title" className="mb-5 text-2xl font-semibold text-ink">数据管理</h1>
      <InvestmentDataManager key={ownerId} ownerId={ownerId} sessionCsrf={sessionCsrf} resumeBackup={resumeBackup} archiveActions={
          <>
            <InvestmentArchiveAction icon={<IconDatabaseExport size={18} />} title="旧版网站档案">
              <Capsule variant="secondary" size="sm" type="button" disabled={backupBusy !== null} onClick={exportSiteBackup}>{backupBusy === "export" ? "导出中…" : "导出 JSON"}</Capsule>
            </InvestmentArchiveAction>
            <InvestmentArchiveAction icon={<IconDatabaseImport size={18} />} title="导入备份文件" description="选择 Alcor 备份，核对后导入。">
              <Capsule variant="secondary" size="sm" type="button" disabled={backupBusy !== null} onClick={() => importBackupRef.current?.click()}>{backupBusy === "import" ? "导入中…" : "选择文件"}</Capsule>
              <input ref={importBackupRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void previewSiteBackup(file);
              }} />
            </InvestmentArchiveAction>
            {pending && <section aria-labelledby={importReviewId} className="grid gap-2 border-t border-edge bg-bg-gray px-4 py-3 text-sm">
              <h3 id={importReviewId} className="break-all font-semibold">{pending.name}</h3>
              <p className="text-xs text-muted">持仓 {pending.plan.counts?.records ?? 0} · 订单 {pending.plan.counts?.tradeOrders ?? 0} · 分组 {pending.plan.counts?.watchGroups ?? 0}</p>
              {pending.plan.confirmSupported ? <p className="text-xs text-muted">确认后合并记录，系统会保留导入前的数据。</p> : <p role="alert" className="text-xs text-down">有 {pending.plan.blocked?.length ?? 0} 项待核对，暂无法导入。</p>}
              <div className="flex flex-wrap gap-2">
                <Capsule variant="secondary" size="sm" disabled={backupBusy !== null} onClick={() => { setPending(undefined); setNotice(undefined); }}>取消</Capsule>
                {pending.plan.confirmSupported && <Capsule size="sm" busy={backupBusy === "import"} onClick={() => void confirmSiteBackup()}>确认导入</Capsule>}
              </div>
            </section>}
            <InvestmentArchiveAction icon={<IconBriefcase size={18} />} title="持仓与自选" description={recordsCount === null ? undefined : `共 ${recordsCount} 条记录。`}>
              <Capsule variant="secondary" size="sm" type="button" disabled={recordsCount === null} onClick={onExport}>导出</Capsule>
            </InvestmentArchiveAction>
            {admin && <PlatformBackups ownerId={ownerId} inline renderTrigger={(toggle, open) => (
              <InvestmentArchiveAction icon={<IconShieldCheck size={18} />} title="联合备份" description="完整数据库、登记原件和加密密钥。">
                <Capsule variant="secondary" size="sm" aria-expanded={open} onClick={toggle}>{open ? "收起" : "管理备份"}</Capsule>
              </InvestmentArchiveAction>
            )} />}
            {admin && <MigrationReadinessCard ownerId={ownerId} />}
            {notice && <p role={notice.error ? "alert" : "status"} className={`border-t border-edge px-4 py-2 text-xs ${notice.error ? "text-down" : "text-muted"}`}>{notice.message}</p>}
          </>
      } />
      <button type="button" className="asset-analysis-resizer data-management-resizer" aria-label="调整数据管理页面宽度"
        title="拖动调整宽度，双击恢复默认" aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={finishResize}
        onPointerCancel={finishResize} onLostPointerCapture={finishResize}
        onDoubleClick={() => setSavedWidth(null)} onKeyDown={resizeWithKeyboard}>
        <span aria-hidden="true" /><i aria-hidden="true">⋮</i>
      </button>
      </div>
    </section>
  );
}
