"use client";

import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh, IconServer } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Capsule } from "@/components/Capsule";
import { InvestmentArchiveAction } from "@/components/InvestmentDataManager";
import { copyText } from "@/lib/clipboard";

type ReadinessData = {
  ready: boolean;
  blockers: string[];
  recommendations: string[];
  database: {
    name: string;
    instanceId: string | null;
    environment: string;
    softwareVersion: string;
    migrationCount: number;
    latestMigration: string | null;
    sizeBytes: number;
    singleDatabaseAuthority: boolean;
    counts: {
      users: number;
      holdings: number;
      nativeLedgers: number;
      checkpointOwners: number;
      ledgerEvents: number;
      dailySnapshots: number;
    };
  };
  checkpoints: {
    totalTargets: number;
    sealedTargets: number;
    unsealedTargets: number;
    allSealed: boolean;
    diskMigrationArchiveNeeded: boolean;
  };
  redis: {
    configured: boolean;
    statelessCacheOnly: boolean;
    migrationRequired: boolean;
    aclKeyPrefix: string | null;
  };
  directories: {
    key: string;
    label: string;
    purpose: string;
    configured: boolean;
    exists: boolean;
    modeOctal: string | null;
    fileCount: number;
    totalBytes: number;
    truncated: boolean;
    required: boolean;
  }[];
  latestBackup: {
    createdAt: string;
    verifiedAt: string | null;
    bytes: number;
    softwareVersion: string;
    sha256Prefix: string;
  } | null;
};

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtLocalTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function MigrationReadinessCard({ ownerId }: { ownerId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReadinessData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/personal-data-transfer/migration-readiness", {
        signal,
        cache: "no-store",
        headers: { "X-Alcor-Expected-Account": ownerId },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : "读取迁移体检失败");
      }
      if (!signal?.aborted) setData(body as ReadinessData);
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "读取迁移体检失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  function copyValue(key: string, value: string) {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
    });
  }

  return (
    <>
      <InvestmentArchiveAction
        icon={<IconServer size={18} />}
        title="VPS 迁移体检"
        description="核对单一 PG 库、期初固化、私有密钥目录与 Redis ACL 清单。"
      >
        <Capsule variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "迁移体检"}
        </Capsule>
      </InvestmentArchiveAction>

      {open && (
        <div className="border-t border-edge bg-bg-gray/60 px-4 py-3.5 text-xs text-ink">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              {data ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold ${
                    data.ready
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {data.ready ? <IconCheck size={13} aria-hidden="true" /> : <IconAlertTriangle size={13} aria-hidden="true" />}
                  {data.ready ? "已具备迁移条件" : `存在 ${data.blockers.length} 项待处理阻断`}
                </span>
              ) : null}
              {data && (
                <span className="text-muted">
                  v{data.database.softwareVersion} · {data.database.migrationCount} 个迁移
                </span>
              )}
            </div>
            <Capsule size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
              <IconRefresh size={14} aria-hidden="true" />刷新体检
            </Capsule>
          </div>

          {error && (
            <p role="alert" className="mb-3 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-down">
              {error}
            </p>
          )}

          {loading && !data && <p className="py-3 text-muted" role="status">正在体检数据库与私有目录…</p>}

          {data && (
            <div className="grid gap-3">
              {data.blockers.length > 0 && (
                <ul className="list-disc space-y-1 rounded-lg border border-down/30 bg-down/10 py-2 pl-6 pr-3 text-down">
                  {data.blockers.map((item, idx) => <li key={idx}>{item}</li>)}
                </ul>
              )}

              {data.recommendations.length > 0 && (
                <ul className="list-disc space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 py-2 pl-6 pr-3 text-amber-800 dark:text-amber-200">
                  {data.recommendations.map((item, idx) => <li key={idx}>{item}</li>)}
                </ul>
              )}

              <div className="grid gap-2 rounded-lg border border-edge bg-white p-3 dark:bg-[#1c1c1e]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[13px] font-semibold">唯一 PostgreSQL 权威库</strong>
                  <span className="font-mono text-muted">
                    {data.database.name} · {fmtBytes(data.database.sizeBytes)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                  <div>
                    <span className="text-muted">最新迁移：</span>
                    <span className="font-mono">{data.database.latestMigration ?? "—"}</span>
                  </div>
                  <div>
                    <span className="text-muted">单库期初固化：</span>
                    <span className={data.checkpoints.allSealed ? "font-semibold text-emerald-700 dark:text-emerald-300" : "font-semibold text-amber-700 dark:text-amber-300"}>
                      {data.checkpoints.sealedTargets}/{data.checkpoints.totalTargets}
                      {data.checkpoints.allSealed ? "（已脱离磁盘迁移包）" : "（待固化）"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted">结构化事件：</span>
                    <span className="tabular-nums">{data.database.counts.ledgerEvents} 条</span>
                  </div>
                  <div>
                    <span className="text-muted">活跃持仓：</span>
                    <span className="tabular-nums">{data.database.counts.holdings} 条</span>
                  </div>
                  <div>
                    <span className="text-muted">日终快照：</span>
                    <span className="tabular-nums">{data.database.counts.dailySnapshots} 条</span>
                  </div>
                  <div>
                    <span className="text-muted">最近整库备份：</span>
                    <span>
                      {data.latestBackup
                        ? `${fmtLocalTime(data.latestBackup.createdAt)} (${fmtBytes(data.latestBackup.bytes)})`
                        : "暂无"}
                    </span>
                  </div>
                </div>
                {data.database.instanceId && (
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-2">
                    <span className="min-w-0 break-all font-mono text-[11px] text-muted">
                      FIRE_INSTANCE_ID={data.database.instanceId}
                    </span>
                    <Capsule
                      size="sm"
                      variant="ghost"
                      onClick={() => copyValue("instance", data.database.instanceId!)}
                    >
                      <IconCopy size={13} aria-hidden="true" />
                      {copiedKey === "instance" ? "已复制" : "复制 UUID"}
                    </Capsule>
                  </div>
                )}
              </div>

              <div className="grid gap-1.5 rounded-lg border border-edge bg-white p-3 dark:bg-[#1c1c1e]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[13px] font-semibold">Redis 缓存与限流</strong>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                    无需搬迁数据 · 新 VPS 重装即可
                  </span>
                </div>
                {data.redis.aclKeyPrefix && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-all font-mono text-[11px] text-muted">
                      最小 ACL 键前缀：{data.redis.aclKeyPrefix}
                    </span>
                    <Capsule
                      size="sm"
                      variant="ghost"
                      onClick={() => copyValue("redis", data.redis.aclKeyPrefix!)}
                    >
                      <IconCopy size={13} aria-hidden="true" />
                      {copiedKey === "redis" ? "已复制" : "复制前缀"}
                    </Capsule>
                  </div>
                )}
              </div>

              <div className="overflow-hidden rounded-lg border border-edge bg-white dark:bg-[#1c1c1e]">
                <div className="border-b border-edge bg-bg-gray/60 px-3 py-2 font-semibold">
                  随 PG 一并打包带走的 4 个私有目录
                </div>
                {data.directories.map((dir) => (
                  <div
                    key={dir.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-edge px-3 py-2 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{dir.label}</div>
                      <div className="text-[11px] text-muted">{dir.purpose}</div>
                    </div>
                    <div className="text-right font-mono tabular-nums text-[11px]">
                      {!dir.configured ? (
                        <span className="text-muted">未配置</span>
                      ) : !dir.exists ? (
                        <span className="text-down">目录缺失</span>
                      ) : (
                        <>
                          <div>
                            {dir.fileCount}{dir.truncated ? "+" : ""} 文件 · {fmtBytes(dir.totalBytes)}
                          </div>
                          <div className="text-muted">权限 {dir.modeOctal}</div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
