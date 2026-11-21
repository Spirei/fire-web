"use client";

import { IconBriefcase, IconDatabaseExport, IconDatabaseImport, IconShieldCheck } from "@tabler/icons-react";
import { useRef, useState, type ReactNode } from "react";
import { Capsule } from "@/components/Capsule";
import InvestmentDataManager from "@/components/InvestmentDataManager";
import PlatformBackups from "@/components/PlatformBackups";
import { appConfirm } from "@/lib/appDialog";
import { showToast } from "@/lib/toast";

function BackupAction({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
    <span className="grid h-8 w-8 place-items-center rounded-lg bg-bg-gray text-muted" aria-hidden="true">{icon}</span>
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>;
}

export default function DataManagementView({ ownerId, admin, recordsCount, onExport }: {
  ownerId: string;
  admin: boolean;
  recordsCount: number | null;
  onExport: () => void;
}) {
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const importBackupRef = useRef<HTMLInputElement>(null);

  async function exportSiteBackup() {
    if (!await appConfirm("旧版档案用于兼容旧版数据格式，下载后请妥善保管。", { title: "导出旧版网站数据" })) return;
    setBackupBusy("export");
    try {
      const res = await fetch("/api/v1/data/export");
      if (!res.ok) throw new Error("导出失败");
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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
        showToast("旧版文件仅含部分记录，完整记录请下载个人账本");
      } else {
        showToast(`已导出：持仓 ${c?.records ?? 0}、订单 ${c?.tradeOrders ?? 0}、分组 ${c?.watchGroups ?? 0}、设置 ${c?.siteSettings ?? 0}、名人持仓 ${c?.celebs ?? 0}`);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "导出失败", "err");
    } finally {
      setBackupBusy(null);
    }
  }

  async function importSiteBackup(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      showToast("备份文件超过 10MB 限制", "err");
      return;
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      showToast("文件解析失败，请选择 Alcor 或旧版备份 JSON", "err");
      return;
    }
    setBackupBusy("import");
    try {
      // 第一步：服务端校验 + 试算条数（不写入）
      const checkRes = await fetch("/api/v1/data/import?preview=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const checkData = await checkRes.json().catch(() => null);
      if (!checkRes.ok) throw new Error(checkData?.error || "备份文件校验失败");
      const counts = checkData?.counts ?? {};
      const summary = [
        `版本：${payload?.appVersion ?? "未知"} · 导出：${(payload?.exportedAt ?? "").replace("T", " ").slice(0, 16)}`,
        `持仓 ${counts.records ?? 0}、订单 ${counts.tradeOrders ?? 0}、分组 ${counts.watchGroups ?? 0}、设置 ${counts.siteSettings ?? 0}、名人持仓 ${counts.celebs ?? 0}${counts.profile ? "、昵称" : ""}`
      ].join("\n");
      if (!await appConfirm(`${summary}\n\n数据将按 id 合并，导入前会自动备份当前数据库。`, { title: "导入网站数据" })) return;
      // 第二步：真正导入
      const res = await fetch("/api/v1/data/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "导入失败");
      const c = data?.counts ?? {};
      showToast(`导入成功：持仓 ${c.records ?? 0}、订单 ${c.tradeOrders ?? 0}、分组 ${c.watchGroups ?? 0}、设置 ${c.siteSettings ?? 0}、名人持仓 ${c.celebs ?? 0}`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "导入失败", "err");
    } finally {
      setBackupBusy(null);
      if (importBackupRef.current) importBackupRef.current.value = "";
    }
  }

  return (
    <section className="data-management-page mx-auto w-full min-w-0 max-w-[1100px]" aria-labelledby="data-management-title">
      <h1 id="data-management-title" className="mb-5 text-2xl font-semibold text-ink">数据管理</h1>
      <InvestmentDataManager key={ownerId} ownerId={ownerId} footer={
        <section aria-labelledby="data-transfer-title">
          <h2 id="data-transfer-title" className="px-3 pt-3 text-xs font-semibold text-muted sm:px-4">{admin ? "导入、导出与备份" : "导入与导出"}</h2>
          <div className="divide-y divide-edge">
            <BackupAction icon={<IconDatabaseExport size={18} />} title="旧版网站档案">
              <Capsule variant="secondary" size="sm" type="button" disabled={backupBusy !== null} onClick={exportSiteBackup}>{backupBusy === "export" ? "导出中…" : "导出 JSON"}</Capsule>
            </BackupAction>
            <BackupAction icon={<IconDatabaseImport size={18} />} title="导入备份文件" description="先导出现有数据留档。选择 Alcor 备份，核对后导入。">
              <Capsule variant="secondary" size="sm" type="button" disabled={backupBusy !== null} onClick={() => importBackupRef.current?.click()}>{backupBusy === "import" ? "导入中…" : "选择文件"}</Capsule>
              <input ref={importBackupRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importSiteBackup(file);
              }} />
            </BackupAction>
            <BackupAction icon={<IconBriefcase size={18} />} title="持仓与自选" description={recordsCount === null ? "下载持仓与自选记录。" : `共 ${recordsCount} 条记录。`}>
              <Capsule variant="secondary" size="sm" type="button" disabled={recordsCount === null} onClick={onExport}>导出</Capsule>
            </BackupAction>
            {admin && <PlatformBackups ownerId={ownerId} renderTrigger={open => (
              <BackupAction icon={<IconShieldCheck size={18} />} title="联合备份" description="完整数据库、登记原件和加密密钥。">
                <Capsule variant="secondary" size="sm" onClick={open}>管理备份</Capsule>
              </BackupAction>
            )} />}
          </div>
        </section>
      } />
    </section>
  );
}
