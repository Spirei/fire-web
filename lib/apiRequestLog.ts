import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { API_REQUEST_ROUTES } from "./apiRequestRoutes";
import { requestDay, type ApiRequestLog, type RequestFilters, type RequestSnapshot, type RequestSource } from "./apiRequestTypes";

const DAY = 86400_000;
const MAX_ROWS = 100_000;
const registry = API_REQUEST_ROUTES.map(template => ({
  template,
  pattern: new RegExp("^" + template.split("/").map(segment => {
    if (segment.startsWith("[[...")) return ".*";
    if (segment.startsWith("[...")) return ".+";
    if (segment.startsWith("[")) return "[^/]+";
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/") + "/?$"),
  dynamic: (template.match(/\[/g) || []).length
})).sort((a, b) => a.dynamic - b.dynamic || b.template.length - a.template.length);

/** An allowlist prevents identifiers, filenames and secrets in arbitrary paths being logged. */
export function requestRoute(raw: string): string | null {
  const pathname = raw.split("?")[0];
  if (!pathname.startsWith("/api/") || /^\/api\/request-logs(?:\/|$)/.test(pathname) || pathname === "/api/health") return null;
  return registry.find(route => route.pattern.test(pathname))?.template || "/api/[unmatched]";
}
export function requestSource(headers: Record<string, string | string[] | undefined>): RequestSource {
  const agent = String(headers["user-agent"] || "");
  if (/Mozilla\//.test(agent)) return "web";
  if (/CFNetwork|Darwin|iPhone|iPad/i.test(agent)) return "ios";
  if (headers["sec-fetch-mode"]) return "web";
  if (/^Bearer /i.test(String(headers.authorization || ""))) return "app";
  return "other";
}

type Pending = Omit<ApiRequestLog, "id">;
type StoreState = {
  db?: Database.Database; queue: Pending[]; listeners: Set<() => void>;
  timer?: NodeJS.Timeout; lastPrune: number; lastError: number; retryAfter?: number;
};
const globalStore = globalThis as typeof globalThis & { __fireRequestLog?: StoreState };
const state = globalStore.__fireRequestLog ||= { queue: [], listeners: new Set(), lastPrune: 0, lastError: 0 };

function database() {
  if (state.db) return state.db;
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "request-logs.sqlite"), { timeout: 100 });
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, path TEXT NOT NULL,
      method TEXT NOT NULL, source TEXT NOT NULL, status INTEGER NOT NULL, duration REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
    CREATE TABLE IF NOT EXISTS request_daily (
      day TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL, source TEXT NOT NULL, status INTEGER NOT NULL,
      count INTEGER NOT NULL, total_ms REAL NOT NULL, PRIMARY KEY(day,path,method,source,status)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS request_hours (
      hour INTEGER NOT NULL, day TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL, source TEXT NOT NULL, status INTEGER NOT NULL,
      count INTEGER NOT NULL, PRIMARY KEY(hour,path,method,source,status)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS request_hours_day ON request_hours(day);
  `);
  state.db = db; return db;
}

export function flushRequestLogs() {
  if (!state.queue.length || Date.now() < (state.retryAfter || 0)) return;
  const batch = state.queue.splice(0);
  try {
    const db = database();
    const insert = db.prepare("INSERT INTO requests(at,path,method,source,status,duration) VALUES (@at,@path,@method,@source,@status,@duration)");
    const daily = db.prepare(`INSERT INTO request_daily(day,path,method,source,status,count,total_ms) VALUES (@day,@path,@method,@source,@status,1,@duration)
      ON CONFLICT(day,path,method,source,status) DO UPDATE SET count=count+1,total_ms=total_ms+excluded.total_ms`);
    const hourly = db.prepare(`INSERT INTO request_hours(hour,day,path,method,source,status,count) VALUES (@hour,@day,@path,@method,@source,@status,1)
      ON CONFLICT(hour,path,method,source,status) DO UPDATE SET count=count+1`);
    db.transaction(() => {
      for (const item of batch) {
        insert.run(item);
        const day = requestDay(item.at);
        daily.run({ ...item, day });
        hourly.run({ ...item, hour: Math.floor(item.at / 3600_000) * 3600_000, day });
      }
      if (Date.now() - state.lastPrune > 600_000) {
        db.prepare("DELETE FROM requests WHERE at < ? OR id <= (SELECT COALESCE(MAX(id),0) - ? FROM requests)").run(Date.now() - 7 * DAY, MAX_ROWS);
        db.prepare("DELETE FROM request_daily WHERE day < ?").run(requestDay(Date.now() - 400 * DAY));
        db.prepare("DELETE FROM request_hours WHERE hour < ?").run(Date.now() - 31 * DAY);
        state.lastPrune = Date.now();
      }
    })();
    state.retryAfter = 0;
    for (const notify of state.listeners) { try { notify(); } catch { /* One disconnected observer cannot stop logging. */ } }
  } catch {
    state.queue = [...batch, ...state.queue].slice(-2048);
    state.retryAfter = Date.now() + 5000;
    if (Date.now() - state.lastError > 60_000) { state.lastError = Date.now(); console.error("API request log storage unavailable"); }
  }
}

export function recordRequest(item: Pending) {
  // This API accepts already-normalized metadata, never a Request/Response body.
  state.queue.push(item);
  if (!state.timer) {
    state.timer = setInterval(flushRequestLogs, 1000); state.timer.unref();
    process.once("exit", flushRequestLogs);
  }
  if (state.queue.length >= 512) flushRequestLogs();
  if (state.queue.length > 2048) state.queue.splice(0, state.queue.length - 2048);
}
export function observeRequestLogs(notify: () => void) {
  if (state.listeners.size >= 20) return null;
  state.listeners.add(notify); return () => { state.listeners.delete(notify); };
}
export function requestLogRevision() {
  return (database().prepare("SELECT COALESCE(MAX(id),0) AS id FROM requests").get() as { id: number }).id;
}

export function readRequestSnapshot(filters: RequestFilters, now = Date.now()): RequestSnapshot {
  flushRequestLogs();
  const db = database();
  const today = requestDay(now);
  const start = filters.day || requestDay(now - (filters.period === "30d" ? 29 : filters.period === "7d" ? 6 : 0) * DAY);
  const end = filters.day || today;
  const parts: string[] = [], values: (string | number)[] = [];
  if (filters.source !== "all") { parts.push("source = ?"); values.push(filters.source); }
  if (filters.method !== "all") { parts.push("method = ?"); values.push(filters.method); }
  if (filters.q) { parts.push("instr(lower(path), lower(?)) > 0"); values.push(filters.q); }
  if (filters.status === "success") parts.push("status < 400");
  if (filters.status === "4xx") parts.push("status BETWEEN 400 AND 498");
  if (filters.status === "5xx") parts.push("status >= 500");
  if (filters.status === "cancelled") parts.push("status = 499");
  const suffix = parts.length ? " AND " + parts.join(" AND ") : "";
  const where = "day >= ? AND day <= ?" + suffix;
  const args = [start, end, ...values];
  const aggregate = db.prepare(`SELECT COALESCE(SUM(count),0) AS total, COALESCE(SUM(CASE WHEN status >= 400 THEN count ELSE 0 END),0) AS errors,
    COALESCE(SUM(CASE WHEN status >= 500 THEN count ELSE 0 END),0) AS serverErrors, COALESCE(SUM(total_ms)/NULLIF(SUM(count),0),0) AS averageMs
    FROM request_daily WHERE ${where}`).get(...args) as RequestSnapshot["summary"];
  const sources = { web: 0, ios: 0, app: 0, other: 0 };
  for (const row of db.prepare(`SELECT source, SUM(count) AS count FROM request_daily WHERE ${where} GROUP BY source`).all(...args) as Array<{ source: RequestSource; count: number }>) sources[row.source] = row.count;
  const endpoints = db.prepare(`SELECT path,method,SUM(count) AS count,SUM(CASE WHEN status>=400 THEN count ELSE 0 END) AS errors,
    SUM(total_ms)/SUM(count) AS averageMs FROM request_daily WHERE ${where} GROUP BY path,method ORDER BY count DESC,path LIMIT 8`).all(...args) as RequestSnapshot["endpoints"];
  const heatmap = Object.fromEntries((db.prepare(`SELECT day, SUM(count) AS count FROM request_daily WHERE day >= ? AND day <= ?${suffix} GROUP BY day`).all(`${filters.year}-01-01`, `${filters.year}-12-31`, ...values) as Array<{ day: string; count: number }>).map(row => [row.day, row.count]));
  const from = Date.parse(`${start}T00:00:00+08:00`), until = Date.parse(`${end}T00:00:00+08:00`) + DAY;
  const revision = requestLogRevision();
  const anchor = filters.anchor ? Math.min(filters.anchor, revision) : revision;
  const logWhere = "at >= ? AND at < ? AND id <= ?" + suffix;
  const logArgs = [from, until, anchor, ...values];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM requests WHERE ${logWhere}`).get(...logArgs) as { total: number }).total;
  const page = Math.min(filters.page, Math.max(1, Math.ceil(total / 20)));
  const logs = db.prepare(`SELECT * FROM requests WHERE ${logWhere} ORDER BY id DESC LIMIT 20 OFFSET ?`).all(...logArgs, (page - 1) * 20) as ApiRequestLog[];
  // Counts come from rollups, so detail retention/capacity never changes the chart or cards.
  const hourlyChart = start === end && from >= now - 30 * DAY;
  const chart = hourlyChart
    ? db.prepare(`SELECT strftime('%Y-%m-%dT%H:00',hour/1000,'unixepoch','+8 hours') AS key,SUM(count) AS count,SUM(CASE WHEN status>=400 THEN count ELSE 0 END) AS errors FROM request_hours WHERE ${where} GROUP BY hour ORDER BY hour`).all(...args)
    : db.prepare(`SELECT day AS key,SUM(count) AS count,SUM(CASE WHEN status>=400 THEN count ELSE 0 END) AS errors FROM request_daily WHERE ${where} GROUP BY day ORDER BY day`).all(...args);
  return { revision, today, summary: { ...aggregate, sources }, chart: chart as RequestSnapshot["chart"], chartUnit: hourlyChart ? "hour" : "day", endpoints, logs,
    pagination: { page, pageSize: 20, total, anchor }, heatmap, detailFrom: now - 7 * DAY };
}
