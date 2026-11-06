"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconDatabase,
  IconBolt,
  IconPackages,
  IconRefresh,
  IconActivity,
  IconClipboardList,
  IconApi,
  IconX,
} from "@tabler/icons-react";
import { useWorkspaceActive } from "@/lib/workspacePanel";
import PasswordInput from "@/components/PasswordInput";
import { ServiceIllustration } from "@/components/ServiceIllustration";

type Mode = "overview" | "tasks" | "migration";
type Service = {
  id: string;
  label: string;
  state: string;
  detail: string;
  observed_at: string | null;
};
type Task = {
  id: string;
  request_id: string;
  kind: string;
  status: string;
  created_at: string;
  attempts: number;
  result: unknown;
  error_code: string | null;
};
type Operation = {
  method: string;
  path: string;
  status: "connected" | "pending" | "presentation";
  client_acceptance: string;
};
type Overview = { services: Service[]; task_counts: Record<string, number> };
type Migration = {
  items: Operation[];
  summary: Record<string, number>;
  retirements?: {
    method: string;
    path: string;
    reason: string;
    replacement: string;
  }[];
};
const labels: Record<string, string> = {
  queued: "等待中",
  running: "运行中",
  cancel_requested: "取消中",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
  up: "已连接",
  down: "未连接",
  pending: "应用中",
  unconfigured: "未配置",
};
const status = (value: string) => labels[value] || value;
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return errorText(o.message || o.detail || o.error);
  }
  return "请求失败";
}
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(errorText(value)) as Error & {
      status: number;
      reauthentication: boolean;
    };
    error.status = response.status;
    error.reauthentication =
      response.headers.get("x-alcor-reauthentication") === "required";
    throw error;
  }
  return value as T;
}
const time = (value: string) => new Date(value).toLocaleString();
function SystemDialog({
  label,
  onClose,
  busy = false,
  children,
}: {
  label: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="system-dialog"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export default function SystemView({
  mode,
  onNavigate,
  ownerId,
}: {
  mode: Mode;
  ownerId: string;
  onNavigate: (path: string) => void;
}) {
  const active = useWorkspaceActive();
  const [overview, setOverview] = useState<Overview | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [migration, setMigration] = useState<Migration | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [connection, setConnection] = useState<"postgresql" | "redis" | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Task | null>(null);
  const [receipt, setReceipt] = useState<{
      request_id: string;
      task?: Task;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const pauseRefresh = useRef(false);
  pauseRefresh.current = busy || !!connection || !!selected;
  const visibleTaskCount = useRef(25);
  visibleTaskCount.current = Math.max(25, tasks.length);
  useEffect(() => setVisibleLimit(100), [filter, query]);
  const csrf = useRef(""),
    generation = useRef(0),
    instance = useRef(""),
    drafts = useRef<
      Partial<
        Record<
          "postgresql" | "redis",
          { config: Config; revision: string | null }
        >
      >
    >({});
  const clear = useCallback(() => {
    csrf.current = "";
    drafts.current = {};
    setCursor(null);
    setFilter("");
    setQuery("");
    setVisibleLimit(100);
    setOverview(null);
    setTasks([]);
    setMigration(null);
    setSelected(null);
    setReceipt(null);
    setConnection(null);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if ([401, 403].includes((e as { status?: number })?.status || 0)) clear();
      setError(e instanceof Error ? e.message : "读取失败");
    },
    [clear],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (document.hidden) return;
      const ticket = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const identity = await json<{
          csrf: string;
          instance_id: string;
          user: { id: string; role: string };
        }>("/api/fire/session", {
          signal,
        });
        if (signal?.aborted || ticket !== generation.current) return;
        if (
          identity.user.id !== ownerId ||
          identity.user.role !== "admin" ||
          (instance.current && instance.current !== identity.instance_id)
        ) {
          clear();
          window.location.reload();
          return;
        }
        instance.current = identity.instance_id;
        if (csrf.current && csrf.current !== identity.csrf) clear();
        csrf.current = identity.csrf;
        const readTasks = async () => {
          const items: Task[] = [];
          let next: string | null = null;
          const count = mode === "tasks" ? visibleTaskCount.current : 25;
          do {
            const page: { items: Task[]; next_cursor: string | null } =
              await json(
                "/api/fire/tasks?limit=" +
                  Math.min(100, count - items.length) +
                  (filter ? "&status=" + filter : "") +
                  (next ? "&cursor=" + encodeURIComponent(next) : ""),
                { signal, headers: { "x-csrf-token": identity.csrf } },
              );
            items.push(...page.items);
            next = page.next_cursor;
          } while (next && items.length < count);
          return { items, next_cursor: next };
        };
        const data = await (mode === "migration"
          ? json<Migration>("/api/fire/system/api-migration", {
              signal,
              headers: { "x-csrf-token": identity.csrf },
            })
          : Promise.all([
              json<Overview>("/api/fire/system/overview", {
                signal,
                headers: { "x-csrf-token": identity.csrf },
              }),
              readTasks(),
            ]));
        if (signal?.aborted || ticket !== generation.current) return;
        if (csrf.current && csrf.current !== identity.csrf) clear();
        csrf.current = identity.csrf;
        if (mode === "migration") setMigration(data as Migration);
        else {
          const [view, list] = data as [
            Overview,
            { items: Task[]; next_cursor: string | null },
          ];
          setOverview(view);
          setTasks(list.items);
          setCursor(list.next_cursor);
          setReceipt((current) => {
            if (!current) return current;
            const task = list.items.find(
              (item) => item.request_id === current.request_id,
            );
            return task ? { ...current, task } : current;
          });
        }
      } catch (e) {
        if (!signal?.aborted && ticket === generation.current) fail(e);
      } finally {
        if (ticket === generation.current) setLoading(false);
      }
    },
    [mode, filter, fail, clear, ownerId],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    const resume = () => {
      if (!document.hidden) void load(controller.signal);
      else {
        setConnection(null);
        setSelected(null);
      }
    };
    document.addEventListener("visibilitychange", resume);
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden && !pauseRefresh.current)
        await load(controller.signal);
      if (!disposed)
        timer = setTimeout(poll, mode === "migration" ? 15000 : 5000);
    };
    timer = setTimeout(poll, mode === "migration" ? 15000 : 5000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      generation.current++;
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, load]);
  useEffect(() => {
    if (!active) setConnection(null);
  }, [active]);
  async function diagnostics() {
    if (busy) return;
    setBusy(true);
    setError("");
    const ticket = generation.current;
    const pending = { request_id: crypto.randomUUID() };
    setReceipt(pending);
    try {
      const task = await json<Task>("/api/fire/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.current,
        },
        body: JSON.stringify({ ...pending, kind: "system.diagnostics" }),
      });
      if (ticket !== generation.current) return;
      setReceipt({ ...pending, task });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function lookup() {
    if (!receipt) return;
    const ticket = generation.current;
    setBusy(true);
    try {
      const task = await json<Task>(
        "/api/fire/tasks/receipts/" + receipt.request_id,
        { headers: { "x-csrf-token": csrf.current } },
      );
      if (ticket !== generation.current) return;
      setReceipt({ ...receipt, task });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(task: Task) {
    setBusy(true);
    try {
      await json("/api/fire/tasks/" + task.id + "/cancel", {
        method: "POST",
        headers: { "x-csrf-token": csrf.current },
      });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function detail(task: Task) {
    const ticket = generation.current;
    try {
      const value = await json<Task>("/api/fire/tasks/" + task.id, {
        headers: { "x-csrf-token": csrf.current },
      });
      if (ticket === generation.current) setSelected(value);
    } catch (e) {
      fail(e);
    }
  }
  async function more() {
    if (!cursor || busy) return;
    const ticket = generation.current;
    setBusy(true);
    try {
      const list = await json<{ items: Task[]; next_cursor: string | null }>(
        "/api/fire/tasks?limit=25&cursor=" +
          encodeURIComponent(cursor) +
          (filter ? "&status=" + filter : ""),
        { headers: { "x-csrf-token": csrf.current } },
      );
      if (ticket === generation.current) {
        setTasks((current) => [
          ...current,
          ...list.items.filter(
            (item) => !current.some((old) => old.id === item.id),
          ),
        ]);
        setCursor(list.next_cursor);
      }
    } catch (e) {
      if (ticket === generation.current) fail(e);
    } finally {
      setBusy(false);
    }
  }
  const visible =
    migration?.items.filter(
      (item) =>
        (!filter || item.status === filter) &&
        (!query ||
          `${item.method} ${item.path}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    ) || [];
  const taskTable = (
    <div className="system-table-wrap">
      <table className="system-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>执行次数</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <button className="text-left" onClick={() => void detail(task)}>
                  {(
                    {
                      "system.diagnostics": "系统连接检查",
                      "backup.create": "创建备份",
                      "backup.verify": "校验备份",
                      "backup.restore": "恢复备份",
                    } as Record<string, string>
                  )[task.kind] || "后台任务"}
                  <small>{task.id.slice(0, 8)}</small>
                </button>
              </td>
              <td>{status(task.status)}</td>
              <td>{time(task.created_at)}</td>
              <td>{task.attempts}</td>
              <td>
                {["queued", "running"].includes(task.status) && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void cancel(task)}
                  >
                    取消
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length && !loading && <p className="system-empty">暂无任务</p>}
      {mode === "tasks" && cursor && (
        <button
          className="btn btn-line"
          disabled={busy}
          onClick={() => void more()}
        >
          加载更多
        </button>
      )}
    </div>
  );
  return (
    <section className="system-workspace">
      <div className="system-heading">
        <h1>
          {mode === "overview"
            ? "系统总览"
            : mode === "tasks"
              ? "后台任务"
              : "接口迁移"}
        </h1>
        <div className="flex gap-3">
          <button
            aria-label="刷新"
            className="btn btn-ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            <IconRefresh size={19} />
          </button>
          {mode !== "migration" && (
            <button
              className="btn btn-primary"
              disabled={busy || !csrf.current}
              onClick={() => void diagnostics()}
            >
              <IconActivity size={19} />
              运行系统检查
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="system-error">
          {error}
        </p>
      )}
      {loading && !overview && !migration && <p role="status">加载中…</p>}
      {receipt && (
        <div className="system-receipt" role="status">
          {receipt.task
            ? `检查任务${status(receipt.task.status)}`
            : "受理结果待核对"}
          <code>{receipt.request_id}</code>
          <button disabled={busy} onClick={() => void lookup()}>
            查询回执
          </button>
        </div>
      )}
      {mode === "overview" && overview && (
        <>
          <div className="system-segment">
            <button aria-current="page">运行总览</button>
            <button onClick={() => onNavigate("/background-tasks")}>
              后台任务
            </button>
          </div>
          <div className="system-section-heading">
            <h2>连接状态</h2>
          </div>
          <div className="system-services">
            {overview.services.map((service) => {
              const Icon =
                service.id === "postgresql"
                  ? IconDatabase
                  : service.id === "redis"
                    ? IconBolt
                    : IconPackages;
              return (
                <article key={service.id} className="system-service">
                  <div className={`system-service-art is-${service.id}`}>
                    <ServiceIllustration kind={service.id} />
                  </div>
                  <div className="system-service-body">
                    <h3>
                      <Icon size={24} stroke={1.6} aria-hidden="true" />
                      {service.id === "worker" ? "Worker" : service.label}
                    </h3>
                    <p className="system-state">
                      <i className={service.state === "up" ? "is-up" : ""} />
                      {service.id === "worker" && service.state === "up"
                        ? "运行中"
                        : status(service.state)}
                    </p>
                    <p className="text-sm text-muted">{service.detail}</p>
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        service.id === "worker"
                          ? onNavigate("/background-tasks")
                          : setConnection(service.id as "postgresql" | "redis")
                      }
                    >
                      {service.id === "worker" ? "管理任务" : "管理连接"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="system-section-heading">
            <div>
              <h2>
                <IconClipboardList size={20} />
                最近任务
              </h2>
              <p className="text-sm text-muted">
                等待 {overview.task_counts.queued || 0} · 运行{" "}
                {overview.task_counts.running || 0} · 完成{" "}
                {overview.task_counts.succeeded || 0}
              </p>
            </div>
            <button onClick={() => onNavigate("/background-tasks")}>
              全部任务
            </button>
          </div>
          {taskTable}
          <div className="system-section-heading">
            <h2>
              <IconApi size={20} />
              接口迁移
            </h2>
            <button onClick={() => onNavigate("/api-migration")}>
              查看清单
            </button>
          </div>
        </>
      )}
      {mode === "tasks" && (
        <>
          <div className="system-filters">
            <select
              aria-label="任务状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              {[
                "queued",
                "running",
                "succeeded",
                "failed",
                "cancelled",
                "cancel_requested",
              ].map((value) => (
                <option key={value} value={value}>
                  {status(value)}
                </option>
              ))}
            </select>
          </div>
          {taskTable}
        </>
      )}
      {mode === "migration" && migration && (
        <>
          <div className="system-api-counts">
            <span>
              接口操作<strong>{migration.summary.total}</strong>
            </span>
            <span>
              后端已登记<strong>{migration.summary.connected}</strong>
            </span>
            <span>
              待接入<strong>{migration.summary.pending}</strong>
            </span>
            <span>
              已清理<strong>{migration.summary.retired || 0}</strong>
            </span>
          </div>
          {!!migration.retirements?.length && (
            <details className="system-connection-receipt">
              <summary>已清理 {migration.retirements.length} 个旧入口</summary>
              <div className="system-table-wrap">
                <table className="system-table">
                  <thead>
                    <tr>
                      <th>旧入口</th>
                      <th>处理结果</th>
                      <th>替代能力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {migration.retirements.map((item) => (
                      <tr key={item.method + item.path}>
                        <td>
                          <code>
                            {item.method} {item.path}
                          </code>
                        </td>
                        <td>{item.reason}</td>
                        <td>
                          <code>{item.replacement}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <div className="system-filters">
            <input
              aria-label="搜索接口"
              placeholder="搜索路径或方法"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="接入状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部接口</option>
              <option value="connected">后端已登记</option>
              <option value="pending">待接入</option>
              {!!migration.summary.presentation && <option value="presentation">网页接口</option>}
            </select>
          </div>
          <div className="system-table-wrap">
            <table className="system-table">
              <thead>
                <tr>
                  <th>方法</th>
                  <th>接口路径</th>
                  <th>接入状态</th>
                  <th>页面验收</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, visibleLimit).map((item) => (
                  <tr key={item.method + item.path}>
                    <td>
                      <code>{item.method}</code>
                    </td>
                    <td>
                      <code>{item.path}</code>
                    </td>
                    <td>
                      {item.status === "connected"
                        ? "后端已登记"
                        : item.status === "pending"
                          ? "待接入"
                          : "Fire 展示接口"}
                    </td>
                    <td>
                      {item.client_acceptance === "verified"
                        ? "已验收"
                        : "待验收"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length > visibleLimit && (
              <button
                className="btn btn-line"
                onClick={() => setVisibleLimit((value) => value + 100)}
              >
                加载更多
              </button>
            )}
          </div>
        </>
      )}
      {selected && (
        <SystemDialog label="任务详情" onClose={() => setSelected(null)}>
          <div className="system-heading">
            <h2>任务详情</h2>
            <button aria-label="关闭" onClick={() => setSelected(null)}>
              <IconX />
            </button>
          </div>
          <p>{status(selected.status)}</p>
          <code className="break-all">{selected.id}</code>
          {selected.error_code && <p role="alert">{selected.error_code}</p>}
          {selected.result == null ? (
            <p className="system-empty">
              {selected.status === "queued"
                ? "任务等待执行"
                : selected.status === "running"
                  ? "任务正在执行，尚无结果"
                  : "此任务没有执行结果"}
            </p>
          ) : (
            <pre className="system-result">
              {JSON.stringify(selected.result, null, 2)}
            </pre>
          )}
        </SystemDialog>
      )}
      {connection && (
        <ConnectionManager
          key={connection}
          kind={connection}
          csrf={csrf.current}
          draft={drafts.current[connection]}
          onDraft={(draft) => {
            drafts.current[connection] = draft;
          }}
          onClose={() => setConnection(null)}
          onSaved={() => void load()}
          onIdentityError={clear}
        />
      )}
    </section>
  );
}

type Config = {
  kind: "postgresql" | "redis";
  host: string;
  port: number;
  username: string;
  database: string | number;
  [key: string]: unknown;
};
type Settings = {
  source: "managed" | "environment";
  config: Config | null;
  effective: Config | null;
  revision: string | null;
  password_set: boolean;
  state: string;
};
type Receipt = {
  request_id: string;
  status: string;
  message: string;
  revision?: string;
};
function ConnectionManager({
  kind,
  csrf,
  onClose,
  onSaved,
  onIdentityError,
  draft,
  onDraft,
}: {
  kind: "postgresql" | "redis";
  csrf: string;
  onClose: () => void;
  onSaved: () => void;
  onIdentityError: () => void;
  draft?: { config: Config; revision: string | null };
  onDraft: (draft: { config: Config; revision: string | null }) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [config, setConfig] = useState<Config>({
      kind,
      host: "",
      port: kind === "postgresql" ? 5432 : 6379,
      username: "",
      database: kind === "postgresql" ? "" : 0,
      ...(kind === "postgresql"
        ? {
            schema_name: "public",
            ssl_mode: "require",
            pool_size: 5,
            pool_min_size: 0,
            max_lifetime: 1800,
            max_idle: 600,
          }
        : { tls: false, max_connections: 10 }),
    });
  const [password, setPassword] = useState(""),
    [passwordMode, setPasswordMode] = useState("keep"),
    [verifyPassword, setVerifyPassword] = useState("");
  const [error, setError] = useState(""),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [requestId, setRequestId] = useState(""),
    [busy, setBusy] = useState(false),
    [verify, setVerify] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    json<Settings>("/api/fire/connections/" + kind, {
      headers: { "x-csrf-token": csrf },
      signal: controller.signal,
    })
      .then((value) => {
        setSettings(
          draft && value.source !== "environment"
            ? { ...value, revision: draft.revision }
            : value,
        );
        if (draft && value.source !== "environment") {
          setConfig(draft.config);
          if (draft.revision !== value.revision)
            setError("连接已变化，请重新读取核对");
        } else if (value.config || value.effective)
          setConfig((value.config || value.effective)!);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorText(e.message));
          if ([401, 403].includes(e.status)) onIdentityError();
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [kind, csrf, onIdentityError]);
  useEffect(() => {
    if (settings && settings.source !== "environment")
      onDraft({ config, revision: settings.revision });
  }, [config, settings, onDraft]);
  async function reload() {
    setBusy(true);
    try {
      const value = await json<Settings>("/api/fire/connections/" + kind, {
        headers: { "x-csrf-token": csrf },
      });
      setSettings(value);
      if (value.config || value.effective)
        setConfig((value.config || value.effective)!);
      setPassword("");
      setPasswordMode("keep");
      setError("");
    } catch (e) {
      setError((e as Error).message);
      if ([401, 403].includes((e as { status: number }).status))
        onIdentityError();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [busy, onClose]);
  const change = (key: string, value: unknown) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setReceipt(null);
    setRequestId("");
  };
  async function operate(action: "test" | "save") {
    if (busy || !settings) return;
    setBusy(true);
    setError("");
    setReceipt(null);
    const id = crypto.randomUUID();
    setRequestId(id);
    try {
      const value = await json<Receipt>(
        "/api/fire/connections/" + kind + (action === "test" ? "/test" : ""),
        {
          method: action === "test" ? "POST" : "PUT",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({
            request_id: id,
            revision: settings.revision,
            config,
            password_mode: passwordMode,
            reuse_current_password: passwordMode === "keep",
            ...(passwordMode === "replace" ? { password } : {}),
          }),
        },
      );
      if (!mounted.current) return;
      setReceipt(value);
      setPassword("");
      setPasswordMode("keep");
      if (action === "save") {
        const current = await json<Settings>("/api/fire/connections/" + kind, {
          headers: { "x-csrf-token": csrf },
        });
        if (mounted.current) setSettings(current);
        onSaved();
      }
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if ((e as { status: number }).status === 401) onIdentityError();
      else if ((e as { status: number }).status === 403) {
        if ((e as { reauthentication?: boolean }).reauthentication)
          setVerify(true);
        else onIdentityError();
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function lookup() {
    setBusy(true);
    try {
      setReceipt(
        await json("/api/fire/connections/" + kind + "/receipts/" + requestId, {
          headers: { "x-csrf-token": csrf },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reauthenticate() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/fire/connections/reauthenticate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ password: verifyPassword }),
      });
      if (!response.ok) throw new Error(errorText(await response.json()));
      setVerify(false);
      setVerifyPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SystemDialog
      label={kind === "postgresql" ? "PostgreSQL 连接" : "Redis 连接"}
      onClose={onClose}
      busy={busy}
    >
      <div className="system-heading">
        <h2>{kind === "postgresql" ? "PostgreSQL" : "Redis"}</h2>
        <button aria-label="关闭" disabled={busy} onClick={onClose}>
          <IconX />
        </button>
      </div>
      {settings?.source === "environment" && (
        <p className="text-sm text-muted">
          连接由服务器环境配置管理，更改后重启生效。
        </p>
      )}
      <fieldset
        className="system-connection-fields"
        disabled={busy || !settings || settings.source === "environment"}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <label>
          主机
          <input
            value={config.host}
            onChange={(e) => change("host", e.target.value)}
          />
        </label>
        <label>
          端口
          <input
            type="number"
            min="1"
            max="65535"
            value={config.port}
            onChange={(e) => change("port", Number(e.target.value))}
          />
        </label>
        <label>
          {kind === "postgresql" ? "数据库" : "数据库编号"}
          <input
            type={kind === "redis" ? "number" : "text"}
            min="0"
            max={kind === "redis" ? 15 : undefined}
            value={config.database}
            onChange={(e) =>
              change(
                "database",
                kind === "redis" ? Number(e.target.value) : e.target.value,
              )
            }
          />
        </label>
        <label>
          用户名
          <input
            autoComplete="off"
            value={config.username}
            onChange={(e) => change("username", e.target.value)}
          />
        </label>
        <label>
          密码
          <select
            value={passwordMode}
            onChange={(e) => {
              setPasswordMode(e.target.value);
              setPassword("");
            }}
          >
            <option value="keep">
              {settings?.password_set ? "保留当前密码" : "不设置密码"}
            </option>
            <option value="replace">设置新密码</option>
            <option value="clear">清除密码</option>
          </select>
        </label>
        {passwordMode === "replace" && (
          <label>
            新密码
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        {kind === "postgresql" ? (
          <label>
            连接加密
            <select
              value={String(config.ssl_mode)}
              onChange={(e) => change("ssl_mode", e.target.value)}
            >
              {["disable", "require", "verify-ca", "verify-full"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
        ) : (
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={config.tls === true}
              onChange={(e) => change("tls", e.target.checked)}
            />
            TLS 加密
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="system-error">
          {error}
        </p>
      )}
      {receipt && <p role="status">{receipt.message}</p>}
      {requestId && (
        <details className="system-connection-receipt">
          <summary>操作回执</summary>
          <div className="system-receipt">
            <code>{requestId}</code>
            <button disabled={busy} onClick={() => void lookup()}>
              查询回执
            </button>
          </div>
        </details>
      )}
      {verify && (
        <div className="system-reauth">
          <label>
            确认管理员密码
            <PasswordInput
              value={verifyPassword}
              onChange={(e) => setVerifyPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button
            className="btn btn-line"
            disabled={busy || !verifyPassword}
            onClick={() => void reauthenticate()}
          >
            验证
          </button>
        </div>
      )}
      <div className="system-actions">
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => void reload()}
        >
          重新读取
        </button>
        <button
          className="btn btn-line"
          disabled={
            busy ||
            !settings ||
            (settings.source === "environment" && !settings.effective)
          }
          onClick={() => void operate("test")}
        >
          测试连接
        </button>
        {settings?.source !== "environment" && (
          <button
            className="btn btn-primary"
            disabled={busy || !settings}
            onClick={() => void operate("save")}
          >
            保存
          </button>
        )}
      </div>
    </SystemDialog>
  );
}
