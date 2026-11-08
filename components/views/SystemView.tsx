"use client";
import { clientRequestId } from "@/lib/randomId";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconDatabase,
  IconBolt,
  IconPackages,
  IconRefresh,
  IconActivity,
  IconClipboardList,
  IconApi,
} from "@tabler/icons-react";
import { useWorkspaceActive, useWorkspaceLocationGuard, useWorkspaceSearchParams } from "@/lib/workspacePanel";
import AppModal from "@/components/AppModal";
import { Capsule, IconButton } from "@/components/Capsule";
import AppSelect from "@/components/AppSelect";
import { platformRequest as json } from "@/lib/platformRequest";
import ApiCatalogue, { type ApiOperation } from "@/components/ApiCatalogue";
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
};
type Overview = { services: Service[]; task_counts: Record<string, number> };
type Migration = {
  etag?: string;
  items: (Operation & ApiOperation)[];
  schemas?: Record<string, unknown>;
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
  return <AppModal title={label} onClose={onClose} closeDisabled={busy} size="lg">{children}</AppModal>;
}

export default function SystemView({
  mode,
  onNavigate,
  ownerId,
  initial,
}: {
  mode: Mode;
  ownerId: string;
  initial?: import("@/lib/workspaceInitial").WorkspaceInitial["system"];
  onNavigate: (path: string) => void;
}) {
  const active = useWorkspaceActive();
  const seed = initial?.mode === mode && initial.identity.user.id === ownerId ? initial : undefined;
  const [overview, setOverview] = useState<Overview | null>(seed?.overview ?? null),
    [tasks, setTasks] = useState<Task[]>(seed?.tasks?.items ?? []),
    [migration, setMigration] = useState<Migration | null>(seed?.directory ?? null);
  const [overviewStale, setOverviewStale] = useState(false);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [connection, setConnection] = useState<"postgresql" | "redis" | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [cursor, setCursor] = useState<string | null>(seed?.tasks?.next_cursor ?? null);
  const params = useWorkspaceSearchParams();
  const canUseLocation = useWorkspaceLocationGuard();
  const taskStatuses = ["queued", "running", "succeeded", "failed", "cancelled", "cancel_requested"];
  const apiStatuses = ["connected", "pending", "presentation"];
  const candidate = params.get("status") || "";
  const filter = (mode === "tasks" ? taskStatuses : mode === "migration" ? apiStatuses : []).includes(candidate) ? candidate : "";
  const query = mode === "migration" ? (params.get("q") || "").slice(0, 200) : "";
  const updateQuery = (key: string, value: string) => {
    if (!canUseLocation()) return;
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    window.history.replaceState(null, "", next.size ? `?${next}` : window.location.pathname);
  };
  const setFilter = (value: string) => updateQuery("status", value);
  const setQuery = (value: string) => updateQuery("q", value);
  const [selected, setSelected] = useState<Task | null>(null);
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
  const actionScope = useRef(0);
  const detailRequest = useRef(0);
  useEffect(() => {
    setBusy(false);
    return () => { actionScope.current++; };
  }, [active, mode, ownerId, filter]);
  const firstSeed = useRef(!!seed);
  const directorySnapshot = useRef<Migration | undefined>(seed?.directory);
  const csrf = useRef(seed?.identity.csrf ?? ""),
    generation = useRef(0),
    instance = useRef(seed?.identity.instance_id ?? "");
  const clear = useCallback(() => {
    csrf.current = "";
    setCursor(null);
    actionScope.current++;
    setBusy(false);
    setVisibleLimit(100);
    setOverview(null);
    setOverviewStale(false);
    setTasks([]);
    setMigration(null);
    directorySnapshot.current = undefined;
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
            }, 30000, directorySnapshot.current?.etag ? { etag: directorySnapshot.current.etag, value: directorySnapshot.current } : undefined)
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
        if (mode === "migration") {
          directorySnapshot.current = data as Migration;
          setMigration(data as Migration);
        }
        else {
          const [view, list] = data as [
            Overview,
            { items: Task[]; next_cursor: string | null },
          ];
          setOverview(view);
          setOverviewStale(false);
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
        if (!signal?.aborted && ticket === generation.current) { setOverviewStale(true); fail(e); }
      } finally {
        if (ticket === generation.current) setLoading(false);
      }
    },
    [mode, filter, fail, clear, ownerId],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    if (firstSeed.current && (mode !== "tasks" || seed?.filter === filter)) firstSeed.current = false;
    else void load(controller.signal);
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
    if (!active) { setConnection(null); setSelected(null); }
  }, [active]);
  async function diagnostics() {
    if (busy) return;
    setBusy(true);
    setError("");
    const ticket = actionScope.current;
    const pending = { request_id: clientRequestId() };
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
      if (ticket !== actionScope.current) return;
      setReceipt({ ...pending, task });
      if (ticket === actionScope.current) await load();
    } catch (e) {
      if (ticket === actionScope.current) fail(e);
    } finally {
      if (ticket === actionScope.current) setBusy(false);
    }
  }
  async function lookup() {
    if (!receipt) return;
    const ticket = actionScope.current;
    setBusy(true);
    try {
      const task = await json<Task>(
        "/api/fire/tasks/receipts/" + receipt.request_id,
        { headers: { "x-csrf-token": csrf.current } },
      );
      if (ticket !== actionScope.current) return;
      setReceipt({ ...receipt, task });
      if (ticket === actionScope.current) await load();
    } catch (e) {
      if (ticket === actionScope.current) fail(e);
    } finally {
      if (ticket === actionScope.current) setBusy(false);
    }
  }
  async function cancel(task: Task) {
    const ticket = actionScope.current;
    setBusy(true);
    try {
      await json("/api/fire/tasks/" + task.id + "/cancel", {
        method: "POST",
        headers: { "x-csrf-token": csrf.current },
      });
      if (ticket === actionScope.current) await load();
    } catch (e) {
      if (ticket === actionScope.current) fail(e);
    } finally {
      if (ticket === actionScope.current) setBusy(false);
    }
  }
  async function detail(task: Task) {
    const ticket = actionScope.current;
    const request = ++detailRequest.current;
    try {
      const value = await json<Task>("/api/fire/tasks/" + task.id, {
        headers: { "x-csrf-token": csrf.current },
      });
      if (ticket === actionScope.current && request === detailRequest.current) setSelected(value);
    } catch (e) {
      if (ticket === actionScope.current && request === detailRequest.current) fail(e);
    }
  }
  async function more() {
    if (!cursor || busy) return;
    const ticket = actionScope.current;
    setBusy(true);
    try {
      const list = await json<{ items: Task[]; next_cursor: string | null }>(
        "/api/fire/tasks?limit=25&cursor=" +
          encodeURIComponent(cursor) +
          (filter ? "&status=" + filter : ""),
        { headers: { "x-csrf-token": csrf.current } },
      );
      if (ticket === actionScope.current) {
        setTasks((current) => [
          ...current,
          ...list.items.filter(
            (item) => !current.some((old) => old.id === item.id),
          ),
        ]);
        setCursor(list.next_cursor);
      }
    } catch (e) {
      if (ticket === actionScope.current) fail(e);
    } finally {
      if (ticket === actionScope.current) setBusy(false);
    }
  }
  const visible =
    migration?.items.filter(
      (item) =>
        (!filter || item.status === filter) &&
        (!query ||
          `${item.method} ${item.path} ${item.summary || ""} ${item.description || ""} ${item.category || ""}`
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
                  <Capsule variant="ghost" size="sm"
                    className=""
                    disabled={busy}
                    onClick={() => void cancel(task)}
                  >
                    取消
                  </Capsule>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length && !loading && <p className="system-empty">暂无任务</p>}
      {mode === "tasks" && cursor && (
        <Capsule variant="secondary"
          className=""
          disabled={busy}
          onClick={() => void more()}
        >
          加载更多
        </Capsule>
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
              : "API 接口"}
        </h1>
        <div className="flex gap-3">
          <IconButton label="刷新" busy={loading} framed onClick={() => void load()}><IconRefresh /></IconButton>
          {mode !== "migration" && (
            <Capsule variant="primary"
              className=""
              disabled={busy || !csrf.current}
              onClick={() => void diagnostics()}
            >
              <IconActivity size={19} />
              运行系统检查
            </Capsule>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="system-error">
          {error}
        </p>
      )}
      {!error && !overview && !migration && !tasks.length && <div className="system-initial-skeleton" role="status" aria-label="正在读取系统数据"><span /><span /><span /></div>}
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
            <Capsule variant="secondary" aria-current="page">运行总览</Capsule>
            <Capsule variant="secondary" onClick={() => onNavigate("/background-tasks")}>后台任务</Capsule>
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
                      <i className={!overviewStale && service.state === "up" ? "is-up" : ""} />
                      {overviewStale ? "待复查" : service.id === "worker" && service.state === "up"
                        ? "运行中"
                        : status(service.state)}
                    </p>
                    <p className="text-sm text-muted">{overviewStale ? `上次结果：${service.detail}` : service.detail}</p>
                    <Capsule variant="primary"
                      className=""
                      onClick={() =>
                        service.id === "worker"
                          ? onNavigate("/background-tasks")
                          : setConnection(service.id as "postgresql" | "redis")
                      }
                    >
                      {service.id === "worker" ? "管理任务" : "管理连接"}
                    </Capsule>
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
              API 接口
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
            <AppSelect
              ariaLabel="任务状态"
              value={filter}
              onChange={setFilter}
              className="system-filter-select"
              options={[{ value: "", label: "全部状态" }, ...["queued", "running", "succeeded", "failed", "cancelled", "cancel_requested"].map(value => ({ value, label: status(value) }))]}
            />
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
              placeholder="搜索名称、路径或方法"
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <AppSelect
              ariaLabel="接口状态"
              value={filter}
              onChange={setFilter}
              className="system-filter-select"
              options={[{ value: "", label: "全部接口" }, { value: "connected", label: "后端已登记" }, { value: "pending", label: "待接入" }, ...(migration.summary.presentation ? [{ value: "presentation", label: "网页接口" }] : [])]}
            />
          </div>
          <ApiCatalogue schemas={migration.schemas} items={visible} category={params.get("category") || ""} onCategory={value => updateQuery("category", value)} />
        </>
      )}
      {active && selected && (
        <SystemDialog label="任务详情" onClose={() => setSelected(null)}>
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
      {active && connection && (
        <ConnectionManager
          key={connection}
          kind={connection}
          csrf={csrf.current}
          onClose={() => setConnection(null)}
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
function ConnectionManager({ kind, csrf, onClose, onIdentityError }: {
  kind: "postgresql" | "redis";
  csrf: string;
  onClose: () => void;
  onIdentityError: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const pending = useRef(false);
  const reject = useCallback((e: unknown) => {
    const value = e as { status?: number; reauthentication?: boolean };
    setError(e instanceof Error ? e.message : "请求失败");
    if (value.status === 403 && value.reauthentication) setVerify(true);
    else if (value.status === 401 || value.status === 403) onIdentityError();
  }, [onIdentityError]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const ticket = ++operation.current;
    pending.current = true;
    setBusy(true);
    json<Settings>("/api/fire/connections/" + kind, {
      headers: { "x-csrf-token": csrf }, signal: controller.signal,
    }).then(value => {
      if (ticket === operation.current) setSettings(value);
    }).catch(e => {
      if (!controller.signal.aborted && ticket === operation.current) reject(e);
    }).finally(() => {
      if (ticket === operation.current) { pending.current = false; setBusy(false); }
    });
    return () => { operation.current++; pending.current = false; controller.abort(); };
  }, [kind, csrf, reject]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || pending.current) return;
    const ticket = ++operation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted && ticket === operation.current) reject(e);
    } finally {
      if (ticket === operation.current) { pending.current = false; setBusy(false); }
    }
  }
  const config = settings?.effective || settings?.config;
  const encryption = kind === "postgresql"
    ? ({ disable: "未启用", require: "加密传输", "verify-ca": "校验服务器证书", "verify-full": "校验证书与主机名" }[String(config?.ssl_mode)] || "—")
    : config ? (config.tls ? "TLS 加密" : "未启用") : "—";
  const field = (label: string, value: unknown, wide = false) => (
    <div className={wide ? "system-connection-wide" : undefined}>
      <dt>{label}</dt><dd>{value === undefined || value === null || value === "" ? "—" : String(value)}</dd>
    </div>
  );
  return (
    <SystemDialog label={kind === "postgresql" ? "PostgreSQL 连接" : "Redis 连接"} onClose={onClose} busy={busy}>
      <p className="text-sm text-muted">连接由服务器环境配置管理，更改后重启生效。</p>
      <dl className="system-connection-summary" aria-busy={busy && !settings}>
        {field("地址", config?.host, true)}
        {field("端口", config?.port)}
        {field(kind === "postgresql" ? "数据库" : "数据库编号", config?.database)}
        {field("用户名", config?.username)}
        {field("密码", settings ? settings.password_set ? "已配置" : "未设置" : undefined)}
        {field("连接加密", encryption, true)}
      </dl>
      {error && <p role="alert" className="system-error">{error}</p>}
      {receipt && <p role="status">{receipt.message}</p>}
      {requestId && (
        <details className="system-connection-receipt">
          <summary>操作回执</summary>
          <div className="system-receipt"><code>{requestId}</code>
            <button disabled={busy} onClick={() => void run(async signal => {
              const value = await json<Receipt>("/api/fire/connections/" + kind + "/receipts/" + requestId, { headers: { "x-csrf-token": csrf }, signal });
              if (!signal.aborted) setReceipt(value);
            })}>查询回执</button>
          </div>
        </details>
      )}
      {verify && (
        <div className="system-reauth">
          <label>确认管理员密码<PasswordInput value={verifyPassword} onChange={e => setVerifyPassword(e.target.value)} autoComplete="current-password" /></label>
          <Capsule variant="secondary" className="" disabled={busy || !verifyPassword} onClick={() => void run(async signal => {
            await json<void>("/api/fire/connections/reauthenticate", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ password: verifyPassword }), signal });
            if (!signal.aborted) { setVerify(false); setVerifyPassword(""); }
          })}>验证</Capsule>
        </div>
      )}
      <div className="system-actions">
        <Capsule variant="ghost" className="" disabled={busy} onClick={() => void run(async signal => {
          const value = await json<Settings>("/api/fire/connections/" + kind, { headers: { "x-csrf-token": csrf }, signal });
          if (!signal.aborted) setSettings(value);
        })}>重新读取</Capsule>
        <Capsule variant="secondary" className="" disabled={busy || !config} onClick={() => void run(async signal => {
          const id = clientRequestId();
          setRequestId(id); setReceipt(null);
          const value = await json<Receipt>("/api/fire/connections/" + kind + "/test", {
            method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, signal,
            body: JSON.stringify({ request_id: id, revision: settings?.revision ?? null, config, password_mode: "keep", reuse_current_password: true }),
          });
          if (!signal.aborted) setReceipt(value);
        })}>{busy ? "处理中…" : "测试连接"}</Capsule>
      </div>
    </SystemDialog>
  );
}
