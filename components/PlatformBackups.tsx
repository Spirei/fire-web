"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import AppModal from "./AppModal";
import BackupHistory, { type BackupHistoryItem } from "./BackupHistory";
import { requestAdminProof } from "@/lib/adminProof";
import { Capsule } from "@/components/Capsule";
import { PlatformRequestError, platformRequest as read } from "@/lib/platformRequest";
import {
  useWorkspaceActive,
  useWorkspaceLocationGuard,
  useWorkspaceSearchParams,
} from "@/lib/workspacePanel";
import { IconLoader2, IconCheck } from "@tabler/icons-react";

type Task = {
  id: string;
  kind: string;
  request_id: string;
  status: string;
  error_code: string | null;
  result: Record<string, unknown> | null;
};
type Listing = {
  items: BackupHistoryItem[];
  configured: boolean;
  key_fingerprint: string | null;
  key_error?: string | null;
  worker_available?: boolean;
};
const states: Record<string, string> = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  cancel_requested: "取消中",
};
export default function PlatformBackups({ ownerId, buttonOnly = false, onClose }: { ownerId: string; buttonOnly?: boolean; onClose?: () => void }) {
  const active = useWorkspaceActive(),
    canUseLocation = useWorkspaceLocationGuard();
  const params=useWorkspaceSearchParams();
  const [open, setOpen] = useState(()=>/^[a-f0-9-]{36}$/i.test(params.get('backupRequest')??'')),
    [data, setData] = useState<Listing | null>(null),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [verify, setVerify] = useState(false),
    [requestId, setRequestId] = useState(""),
    [task, setTask] = useState<Task | null>(null);
  const operation = useRef(0);
  const taskOwner=useRef(ownerId);
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
    setVerify(false);
    setReadError("");
    setReady(false);
    csrf.current = "";
  }, []);
  useEffect(()=>{if(taskOwner.current!==ownerId){taskOwner.current=ownerId;reset();setOpen(false);}},[ownerId,reset]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const ticket = ++generation.current;
      setReady(false);
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
        setReady(true);
        setReadError("");
        setError("");
      } catch (e) {
        if (!signal?.aborted && ticket === generation.current) {
          const failure = e as PlatformRequestError;
          if (failure.status === 401 || failure.status === 403) {
            reset();
            setOpen(false);
          }
          setReadError(failure.message);
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
    if (!active) {
      close();
    }
  }, [active]);
  async function prepare() {
    if (!ready || busy) return;
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
      if (ticket === operation.current) { setError((e as Error).message); setVerify(!!(e as {reauthentication?: boolean}).reauthentication); }
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }
  async function start() {
    if (!ready || !saved || busy || !data?.key_fingerprint) return;
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
          setVerify(!!(e as {reauthentication?: boolean}).reauthentication);
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
      if (ticket === operation.current) { setError((e as Error).message); setVerify(!!(e as {reauthentication?: boolean}).reauthentication); }
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }
  function close() {
    generation.current++;
    operation.current++;
    setBusy(false);setData(null);setSaved(false);setVerify(false);setError('');setReadError('');setReady(false);csrf.current='';
    setOpen(false);
    onClose?.();
  }
  const progress=task?.result?.progress as {phase?:string;processed?:number;total?:number|null;unit?:string}|undefined;
  const processed=typeof progress?.processed==='number'&&Number.isFinite(progress.processed)&&progress.processed>=0?progress.processed:0;
  const total=typeof progress?.total==='number'&&Number.isFinite(progress.total)&&progress.total>0?progress.total:null;
  const phaseLabels:Record<string,string>={backup_snapshot:'准备一致快照',backup_sources:'核对备份原件',backup_tables:'逐表校验',backup_database:'归档数据库',backup_encrypt:'加密备份',backup_verify:'校验备份文件',backup_publish:'保存备份'};
  const running=!!task&&['queued','running','cancel_requested'].includes(task.status);
  const pending=!!requestId&&(!task||running);
  return (
    <>
      <div className={buttonOnly ? undefined : "sw-row"}>
        {!buttonOnly && <div className="sw-row-label">
          <b>联合备份</b>
          <span>完整 PG、登记原件与加密密钥 · 独立 Worker</span>
        </div>}
        <Capsule variant={buttonOnly ? "primary" : "secondary"} size="sm"
          type="button"
          className=""
          onClick={() => setOpen(true)}
        >
          {buttonOnly ? requestId&&(!task||["queued","running","cancel_requested"].includes(task.status))?"查看备份进度":"创建备份" : "管理备份"}
        </Capsule>
      </div>
      {open && taskOwner.current===ownerId && (
        <AppModal
          title="联合备份"
          size="lg"
          className="backup-management-modal"
          desc="包含所有用户和执行状态；恢复密钥须独立保存。"
          onClose={close}
        >
          {!data && !readError && <p role="status">正在核对当前实例…</p>}
          {data && !data.configured && (
            <p>请先配置私有备份目录和独立恢复密钥目录。</p>
          )}
          {data?.key_error && <p role="alert" className="system-error">{data.key_error}</p>}
          {data?.configured && !data.key_error && !pending && (
            <div className="flex flex-col gap-4 text-sm">
              {data.worker_available === false && <div className="flex flex-wrap items-center justify-between gap-3"><span role="status">后台任务进程未连接，暂时无法执行备份。</span><Capsule variant="secondary" size="sm" busy={busy} onClick={() => void load()}>重新检查</Capsule></div>}
              {!data.key_fingerprint ? (
                <Capsule variant="secondary"
                  className="px-4 py-3"
                  disabled={busy || !ready}
                  onClick={() => void prepare()}
                >
                  准备备份恢复密钥
                </Capsule>
              ) : (
                <>
                  <dl className="backup-key-fingerprint"><dt>恢复密钥指纹</dt><dd><code>{data.key_fingerprint}</code></dd></dl>
                  <p>
                    请单独保管配置中备份密钥目录里的
                    backup.key；网页不读取或下载密钥原文。
                  </p>
                  <label className="backup-key-confirmation">
                    <input
                      type="checkbox"
                      checked={saved}
                      onChange={(e) => setSaved(e.target.checked)}
                    />{" "}
                    已独立保存恢复密钥
                  </label>
                  <Capsule variant="primary"
                    className="px-4 py-3"
                    disabled={
                      busy ||
                      !ready ||
                      !saved ||
                      data.worker_available === false ||
                      (!!requestId && !task) ||
                      (!!task &&
                        ["queued", "running", "cancel_requested"].includes(
                          task.status,
                        ))
                    }
                    onClick={() => void start()}
                  >
                    创建完整联合备份
                  </Capsule>
                </>
              )}
            </div>
          )}
          {requestId && <div className="backup-operation-progress mt-4" role="status">
            <div className="flex flex-wrap items-center gap-3">{running?<IconLoader2 size={18} className="animate-spin motion-reduce:animate-none"/>:task?.status==='succeeded'?<IconCheck size={18}/>:null}<strong>{task?.status==='running'?(phaseLabels[progress?.phase??'']??'正在备份'):task?.status==='succeeded'?'备份已完成':task?states[task.status]??task.status:'受理结果待核对'}</strong>
              {task?.status==='running'&&(total!==null||processed>0)&&<span className="ml-auto tabular-nums text-sm text-ink-3">{processed}{total!==null?' / '+total:''}{progress?.unit==='tables'?' 张表':progress?.unit==='objects'?' 项':''}</span>}
              {!task&&<Capsule variant="secondary" size="sm" disabled={busy||!csrf.current} onClick={()=>void lookup()}>查询原任务</Capsule>}
            </div>
            {task?.status==='running'&&total!==null&&<div className="migration-stage-progress" role="progressbar" aria-label="当前备份阶段" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(processed,total)}><span style={{width:`${Math.min(100,processed/total*100)}%`}}/></div>}
            {task?.status==='failed'&&!!task.result?.message&&<p className="mt-3 text-sm text-red-500" role="alert">{String(task.result.message)}</p>}
          </div>}
          {data && (data.items.length>0||!pending) && <BackupHistory items={data.items} downloads />}
          {readError && <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p role="alert" className="system-error">{readError}</p><Capsule variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>重新读取</Capsule></div>}
          {verify && <div className="mt-4"><Capsule variant="secondary" busy={busy} onClick={async () => {
            if (busy) return;
            const ticket = ++operation.current;
            setBusy(true);
            try {
              const proof = await requestAdminProof();
              if (!proof || ticket !== operation.current) return;
              await read("/api/fire/connections/reauthenticate", {method:"POST", headers:{"content-type":"application/json","x-csrf-token":csrf.current}, body:JSON.stringify(proof)});
              if (ticket === operation.current) { setVerify(false); setError(""); await load(); }
            } catch (e) { if (ticket === operation.current) setError((e as Error).message); }
            finally { if (ticket === operation.current) setBusy(false); }
          }}>验证身份</Capsule></div>}
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
