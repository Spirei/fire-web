"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import AppModal from "./AppModal";
import {
  useWorkspaceActive,
  useWorkspaceLocationGuard,
} from "@/lib/workspacePanel";
type Task = {
  id: string;
  kind: string;
  request_id: string;
  status: string;
  error_code: string | null;
  result: Record<string, unknown> | null;
};
type Backup = {
  id: string;
  created_at: string;
  bytes: number;
  sha256: string;
  verified_at: string | null;
  download_available: boolean;
};
type Listing = {
  items: Backup[];
  configured: boolean;
  key_fingerprint: string | null;
};
const states: Record<string, string> = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  cancel_requested: "取消中",
};
async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { cache: "no-store", ...init });
  const v = await r.json();
  if (!r.ok)
    throw Object.assign(
      new Error(
        typeof v.error === "string"
          ? v.error
          : v.error?.message || v.detail || "读取失败",
      ),
      { status: r.status },
    );
  return v;
}
export default function PlatformBackups({ ownerId }: { ownerId: string }) {
  const active = useWorkspaceActive(),
    canUseLocation = useWorkspaceLocationGuard();
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Listing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [requestId, setRequestId] = useState(""),
    [task, setTask] = useState<Task | null>(null);
  const operation = useRef(0);
  const csrf = useRef(""),
    instance = useRef(""),
    generation = useRef(0);
  const reset = useCallback(() => {
    operation.current++;
    setBusy(false);
    setData(null);
    setTask(null);
    setRequestId("");
    setSaved(false);
    csrf.current = "";
  }, []);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const ticket = ++generation.current;
      try {
        const identity = await read<{
          user: { id: string; role: string };
          instance_id: string;
          csrf: string;
        }>("/api/fire/session", { signal });
        if (signal?.aborted || ticket !== generation.current) return;
        if (
          identity.user.id !== ownerId ||
          identity.user.role !== "admin" ||
          (instance.current && identity.instance_id !== instance.current)
        ) {
          reset();
          setOpen(false);
          window.location.reload();
          return;
        }
        if (csrf.current && csrf.current !== identity.csrf) reset();
        csrf.current = identity.csrf;
        instance.current = identity.instance_id;
        const listing = await read<Listing>("/api/fire/backups", {
          signal,
          headers: { "x-csrf-token": identity.csrf },
        });
        if (signal?.aborted || ticket !== generation.current) return;
        setData(listing);
        setError("");
      } catch (e) {
        if (!signal?.aborted && ticket === generation.current) {
          reset();
          setError((e as Error).message);
        }
      }
    },
    [ownerId, reset],
  );
  useEffect(() => {
    if (!open || !active) return;
    const controller = new AbortController();
    void load(controller.signal);
    const id = new URLSearchParams(window.location.search).get("backupRequest");
    if (id && /^[a-f0-9-]{36}$/.test(id)) setRequestId(id);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [open, active, load]);
  useEffect(() => {
    if (!open || !active || !requestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const check = async () => {
      if (!document.hidden && !busy && csrf.current)
        try {
          const current = await read<Task>(
            "/api/fire/tasks/receipts/" + requestId,
            {
              signal: controller.signal,
              headers: { "x-csrf-token": csrf.current },
            },
          );
          if (!stopped) {
            if (
              current.request_id !== requestId ||
              current.kind !== "backup.create"
            )
              throw new Error("原请求与联合备份不匹配");
            setTask(current);
            setError("");
            if (current.status === "succeeded") void load(controller.signal);
            if (
              !["queued", "running", "cancel_requested"].includes(
                current.status,
              )
            )
              return;
          }
        } catch (e) {
          if (!stopped) {
            if ([401, 403].includes((e as { status?: number }).status || 0)) {
              reset();
              setOpen(false);
            }
            setError((e as Error).message);
          }
        }
      if (!stopped) timer = setTimeout(check, 2500);
    };
    void check();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, active, requestId, busy, load, reset]);
  useEffect(() => {
    if (!open) return;
    const hidden = () => {
      if (document.hidden) {
        close();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [open]);
  useEffect(() => {
    if (!active) {
      close();
    }
  }, [active]);
  async function prepare() {
    const ticket = ++operation.current;
    setBusy(true);
    try {
      await read("/api/fire/backups/prepare", {
        method: "POST",
        headers: { "x-csrf-token": csrf.current },
      });
      if (ticket !== operation.current) return;
      await load();
    } catch (e) {
      if (ticket === operation.current) setError((e as Error).message);
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }
  async function start() {
    if (!saved || busy || !data?.key_fingerprint) return;
    const ticket = ++operation.current;
    const id = crypto.randomUUID();
    setBusy(true);
    setTask(null);
    setRequestId(id);
    setError("");
    if (canUseLocation()) {
      const u = new URL(window.location.href);
      u.searchParams.set("backupRequest", id);
      window.history.replaceState(null, "", u);
    }
    try {
      const current = await read<Task>("/api/fire/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.current,
        },
        body: JSON.stringify({ request_id: id, kind: "backup.create" }),
      });
      if (ticket === operation.current) setTask(current);
    } catch (e) {
      if (ticket === operation.current) {
        const status = (e as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 408) {
          setRequestId("");
          if (canUseLocation()) {
            const u = new URL(window.location.href);
            u.searchParams.delete("backupRequest");
            window.history.replaceState(null, "", u);
          }
          setError((e as Error).message);
        } else
          setError("受理结果待核对，请查询原请求编号。" + (e as Error).message);
      }
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }
  async function lookup() {
    const ticket = ++operation.current;
    setBusy(true);
    try {
      const current = await read<Task>(
        "/api/fire/tasks/receipts/" + requestId,
        { headers: { "x-csrf-token": csrf.current } },
      );
      if (ticket !== operation.current) return;
      if (current.request_id !== requestId || current.kind !== "backup.create")
        throw new Error("原请求与联合备份不匹配");
      setTask(current);
      await load();
    } catch (e) {
      if (ticket === operation.current) setError((e as Error).message);
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }
  function close() {
    generation.current++;
    reset();
    setOpen(false);
  }
  return (
    <>
      <div className="sw-row">
        <div className="sw-row-label">
          <b>联合备份</b>
          <span>完整 PG、登记原件与加密密钥 · 独立 Worker</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen(true)}
        >
          管理备份
        </button>
      </div>
      {open && (
        <AppModal
          title="联合备份"
          desc="包含所有用户和执行状态；恢复密钥须独立保存。"
          onClose={close}
        >
          {!data && <p role="status">正在核对当前实例…</p>}
          {data && !data.configured && (
            <p>请先配置私有备份目录和独立恢复密钥目录。</p>
          )}
          {data?.configured && (
            <div className="flex flex-col gap-4 text-sm">
              {!data.key_fingerprint ? (
                <button
                  className="btn btn-line px-4 py-3"
                  disabled={busy}
                  onClick={() => void prepare()}
                >
                  准备备份恢复密钥
                </button>
              ) : (
                <>
                  <p className="break-all">
                    恢复密钥指纹：{data.key_fingerprint}
                  </p>
                  <p>
                    请单独保管配置中备份密钥目录里的
                    backup.key；网页不读取或下载密钥原文。
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={saved}
                      onChange={(e) => setSaved(e.target.checked)}
                    />{" "}
                    已独立保存恢复密钥
                  </label>
                  <button
                    className="btn btn-primary px-4 py-3"
                    disabled={
                      busy ||
                      !saved ||
                      (!!requestId && !task) ||
                      (!!task &&
                        ["queued", "running", "cancel_requested"].includes(
                          task.status,
                        ))
                    }
                    onClick={() => void start()}
                  >
                    创建完整联合备份
                  </button>
                </>
              )}
            </div>
          )}
          {requestId && (
            <div className="system-receipt mt-4">
              <code>{requestId}</code>
              <span>
                {task ? states[task.status] || task.status : "受理结果待核对"}
              </span>
              <button
                disabled={busy || !csrf.current}
                onClick={() => void lookup()}
              >
                查询原请求
              </button>
            </div>
          )}
          {task?.result && (
            <p className="mt-3 text-sm">{String(task.result.message || "")}</p>
          )}
          {!!data?.items.length && (
            <div className="system-table-wrap mt-4">
              <table className="system-table">
                <thead>
                  <tr>
                    <th>创建时间</th>
                    <th>大小</th>
                    <th>备份</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((b) => (
                    <tr key={b.id}>
                      <td>{new Date(b.created_at).toLocaleString()}</td>
                      <td>{(b.bytes / 1024 / 1024).toFixed(1)} MB</td>
                      <td>
                        {b.download_available ? (
                          <a href={`/api/fire/backups/${b.id}/download`}>
                            下载加密备份
                          </a>
                        ) : (
                          "已按保留策略清理"
                        )}
                        <small className="break-all">SHA-256 {b.sha256}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && !data.items.length && (
            <p className="system-empty">暂无联合备份</p>
          )}
          {error && (
            <p role="alert" className="system-error">
              {error}
            </p>
          )}
        </AppModal>
      )}
    </>
  );
}
