/* ---------- 限流（登录 / 注册 / 改密 / 公开接口防爆破与滥用） ----------
 *
 * 默认使用 SQLite 持久化存储：同一主机的多进程（如 Next 多 worker / PM2 集群）
 * 共享计数，服务重启不清零；通过环境变量 RATE_LIMIT_STORE=memory 可回退到
 * 进程内存态（最快，但仅单实例）。任何存储异常都会自动回退内存，不影响请求。
 */

import { getDb } from "./db";
import { createHash } from "crypto";

const buckets = new Map<string, { count: number; resetAt: number }>();

function useSqlite(): boolean {
  return (process.env.RATE_LIMIT_STORE || "sqlite").toLowerCase() !== "memory";
}

export function clientIp(request: Request): string {
  // 转发头可由客户端伪造；只有明确位于可信反向代理后时才使用。
  if (!/^(1|true|yes)$/i.test(process.env.FIRE_TRUST_PROXY_HEADERS || "")) return "direct";
  const fwd = request.headers.get("x-forwarded-for");
  const xri = request.headers.get("x-real-ip");
  const candidate = fwd ? fwd.split(",")[0].trim() : "";
  const ip = candidate || xri || "";
  // 仅接受格式合法的 IP（IPv4 / IPv6），非法值一律归入 unknown，防止垃圾值注入绕过
  if (/^[\d.a-fA-F:]+$/.test(ip)) return ip;
  return "unknown";
}

/** 登录标识只以摘要进入限流表，避免在运维数据中保存邮箱或用户名。 */
export function loginIdentityKey(login: string): string {
  return createHash("sha256").update(login.trim().toLowerCase()).digest("hex");
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  if (useSqlite()) {
    try {
      const db = getDb();
      const now = Date.now();
      const row = db
        .prepare("SELECT count, reset_at FROM rate_limit WHERE key = ?")
        .get(key) as { count: number; reset_at: number } | undefined;
      if (!row || row.reset_at < now) {
        db.prepare(
          "INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at"
        ).run(key, now + windowMs);
        return true;
      }
      if (row.count >= limit) return false;
      db.prepare("UPDATE rate_limit SET count = count + 1 WHERE key = ?").run(key);
      return true;
    } catch {
      // SQLite 不可用（如仅 PostgreSQL 模式 / 磁盘异常）时回退内存
      return memoryRateLimit(key, limit, windowMs);
    }
  }
  return memoryRateLimit(key, limit, windowMs);
}

function memoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** 全局预算：与按 IP 限流叠加，即使伪造 X-Forwarded-For 也无法无限绕过 */
export function rateLimitGlobal(category: string, limit: number, windowMs: number): boolean {
  return rateLimit(`global:${category}`, limit, windowMs);
}

// 定期清理过期桶，防止 Map 无限增长
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
  // SQLite 表同样清理过期行，防止无限增长
  if (useSqlite()) {
    try {
      getDb().prepare("DELETE FROM rate_limit WHERE reset_at < ?").run(now);
    } catch {
      /* 忽略清理失败 */
    }
  }
}, 10 * 60 * 1000);
cleaner.unref?.();
