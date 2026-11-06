export type RequestSource = "web" | "ios" | "app" | "other";
export interface RequestFilters {
  period: "today" | "7d" | "30d";
  status: "all" | "success" | "4xx" | "5xx" | "cancelled";
  source: "all" | RequestSource;
  method: string;
  q: string;
  page: number;
  anchor: number;
  day: string;
  year: number;
}
export interface ApiRequestLog {
  id: number; at: number; path: string; method: string;
  source: RequestSource; status: number; duration: number;
}
export interface RequestMetrics {
  total: number; errors: number; serverErrors: number; averageMs: number;
  sources: Record<RequestSource, number>;
}
export interface RequestSnapshot {
  revision: number;
  today: string;
  summary: RequestMetrics;
  chart: Array<{ key: string; count: number; errors: number }>;
  chartUnit: "hour" | "day";
  endpoints: Array<{ path: string; method: string; count: number; errors: number; averageMs: number }>;
  logs: ApiRequestLog[];
  pagination: { page: number; pageSize: number; total: number; anchor: number };
  heatmap: Record<string, number>;
  detailFrom: number;
}

export function requestDay(at = Date.now()) {
  return new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
}

export function parseRequestFilters(params: URLSearchParams, now = Date.now()): RequestFilters {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(key); return allowed.includes(value as T) ? value as T : fallback;
  };
  const int = (key: string, fallback: number, max: number) => {
    const value = Number(params.get(key)); return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  };
  const today = requestDay(now);
  const year = Number(today.slice(0, 4));
  const selectedYear = int("rYear", year, year);
  const day = params.get("rDay") || "";
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day && day <= today;
  return {
    period: pick("rPeriod", ["today", "7d", "30d"], "today"),
    status: pick("rStatus", ["all", "success", "4xx", "5xx", "cancelled"], "all"),
    source: pick("rSource", ["all", "web", "ios", "app", "other"], "all"),
    method: pick("rMethod", ["all", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"], "all"),
    q: (params.get("rQ") || "").trim().slice(0, 120),
    page: int("rPage", 1, 5000), anchor: int("rAnchor", 0, Number.MAX_SAFE_INTEGER),
    day: validDay && day >= `${year - 1}-01-01` ? day : "",
    year: selectedYear >= year - 1 ? selectedYear : year
  };
}
