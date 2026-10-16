import { createHash } from "node:crypto";
import { getDb } from "./db";
import { clientIp } from "./rateLimit";

export class AuthBudgetError extends Error {
  constructor(public retryAfter: number, public unavailable = false) {
    super(unavailable ? "账户服务暂不可用，请稍后重试" : "操作过于频繁，请稍后再试");
  }
}
type Rule = { key: string; limit: number; windowMs: number };
const minute = 60_000, day = 24 * 60 * minute;

/** One IMMEDIATE transaction admits all windows or none. Security budgets must
 * survive restarts/workers and storage errors, including memory-limit mode. */
export function reserveAuthBudget(rules: Rule[]) {
  try {
    getDb().transaction(() => {
      const db = getDb(), now = Date.now();
      let retryAfter = 0;
      for (const rule of rules) {
        const row = db.prepare("SELECT count,reset_at FROM rate_limit WHERE key=?").get(rule.key) as { count: number; reset_at: number } | undefined;
        if (row && row.reset_at > now && row.count >= rule.limit) retryAfter = Math.max(retryAfter, Math.ceil((row.reset_at - now) / 1000));
      }
      if (retryAfter) throw new AuthBudgetError(retryAfter);
      for (const rule of rules) {
        db.prepare(`INSERT INTO rate_limit(key,count,reset_at) VALUES(?,1,?)
          ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
          reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`)
          .run(rule.key, now + rule.windowMs, now, now);
      }
    }).immediate();
  } catch (error) {
    if (error instanceof AuthBudgetError) throw error;
    throw new AuthBudgetError(60, true);
  }
}

function sourceKey(request: Request) {
  let ip = clientIp(request);
  // IPv6 privacy-address rotation within one /64 must not mint new accounts.
  if (ip.includes(":")) {
    const [left, right = ""] = ip.split("::");
    const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
    ip = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b].slice(0, 4).map(value => parseInt(value, 16).toString(16)).join(":") + "::/64";
  }
  return createHash("sha256").update(ip).digest("hex");
}

export function registrationAttempt(request: Request) {
  const source = sourceKey(request);
  reserveAuthBudget([
    { key: `register-burst:${source}`, limit: 5, windowMs: minute },
    { key: `register-attempt:${source}`, limit: 10, windowMs: 15 * minute },
    { key: "global:register-attempt", limit: 50, windowMs: 15 * minute }
  ]);
}

/** Reserve inside the same transaction as user/session creation. Rejected input,
 * duplicate usernames and failed writes never consume successful-account slots. */
export function registrationCreation(request: Request) {
  const source = sourceKey(request), knownSource = !["direct", "unknown"].includes(clientIp(request));
  reserveAuthBudget([
    { key: `register-created-minute:${source}`, limit: 1, windowMs: minute },
    { key: `register-created-day:${source}`, limit: knownSource ? 5 : 20, windowMs: day },
    { key: "global:register-created-day", limit: 100, windowMs: day }
  ]);
}

export function authenticationBurst(request: Request, factor = false) {
  const category = factor ? "login-factor" : "login";
  reserveAuthBudget([
    { key: `${category}-burst:${sourceKey(request)}`, limit: factor ? 12 : 10, windowMs: minute },
    { key: `global:${category}-burst`, limit: factor ? 30 : 20, windowMs: minute },
    { key: `${category}-window:${sourceKey(request)}`, limit: factor ? 40 : 50, windowMs: 15 * minute },
    { key: `global:${category}-window`, limit: factor ? 80 : 100, windowMs: 15 * minute }
  ]);
}

export function authBudgetHeaders(error: AuthBudgetError): Record<string, string> {
  return { "Retry-After": String(error.retryAfter), "Cache-Control": "no-store" };
}
