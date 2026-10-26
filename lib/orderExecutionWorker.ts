import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { orderExecutionAuthorized as authorized } from "./orderExecutionAuthorization";
import { fetchOverviewQuotes } from "./quotes";
import { observeScheduledTrade } from "./appTrading";

type Candidate = { id: string; user_id: string; market: string; code: string; revision: number; grant_id: string };
const owner = randomUUID();
const runtime = globalThis as typeof globalThis & { __alcorOrderTimer?: ReturnType<typeof setInterval> };
let working = false;
export async function orderExecutionTick() {
  if (working) return;
  const db = getDb(), now = Date.now();
  const acquired = db.prepare("UPDATE app_order_worker_lease SET owner=?,until_at=? WHERE id=1 AND until_at<=?").run(owner,now+30000,now).changes;
  if (!acquired) return;
  working = true;
  const lease = () => !!db.prepare("SELECT 1 FROM app_order_worker_lease WHERE id=1 AND owner=? AND until_at>?").get(owner,Date.now());
  try {
    // Fair persisted cursor survives process restarts. New child orders enter the next batch.
    const rows = db.prepare(`SELECT o.id,o.user_id,o.market,o.code,v.revision,json_extract(m.draft_json,'$.executionGrant') grant_id
      FROM trade_orders o JOIN app_trade_metadata m ON m.order_id=o.id JOIN app_asset_order_versions v ON v.order_id=o.id
      LEFT JOIN app_order_worker_scans s ON s.order_id=o.id
      WHERE o.status='pending' AND json_extract(m.draft_json,'$.executionGrant') IS NOT NULL
      ORDER BY COALESCE(s.scanned_at,0),o.created_at,o.id LIMIT 64`).all() as Candidate[];
    const ready: Candidate[] = [];
    for (const row of rows) {
      db.prepare("INSERT INTO app_order_worker_scans(order_id,scanned_at) VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET scanned_at=excluded.scanned_at").run(row.id,Date.now());
      if (authorized(row.user_id,row.grant_id)) ready.push(row);
    }
    // Expiry is independent of provider availability. The same transaction guards manual/worker races.
    for (const row of ready) {
      if (!lease()) break;
      observeScheduledTrade(row.user_id,row.id,row.revision,row.grant_id,undefined,() => lease() && authorized(row.user_id,row.grant_id) ? row.user_id : "");
    }
    if (!ready.length || !lease()) return;
    const snapshot = await fetchOverviewQuotes(ready.map(r => ({id:r.id,market:r.market,code:r.code})),1500,{tracked:false});
    for (const row of ready) {
      if (!lease()) break;
      const quote = snapshot.quotes[row.id];
      if (!quote || snapshot.cached.includes(row.id)) continue;
      try {
        const outcome = observeScheduledTrade(row.user_id,row.id,row.revision,row.grant_id,quote,() => lease() && authorized(row.user_id,row.grant_id) ? row.user_id : "");
        if (outcome) db.prepare("UPDATE app_order_worker_scans SET result=? WHERE order_id=?").run(outcome.error?.message ?? null,row.id);
      } catch {
        // Failed transaction leaves the pending order intact. No price or credential enters logs.
        console.warn("[order-worker] order verification failed");
      }
    }
  } finally {
    working = false;
    db.prepare("UPDATE app_order_worker_lease SET until_at=0 WHERE id=1 AND owner=?").run(owner);
  }
}
export function startOrderExecutionWorker() {
  // Never run financial workers in build, tests or the local development instance.
  if (runtime.__alcorOrderTimer || process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build" || process.env.npm_lifecycle_event === "build" || process.argv.includes("build")) return;
  runtime.__alcorOrderTimer = setInterval(() => { void orderExecutionTick().catch(() => console.warn("[order-worker] scan failed")); },5000);
  runtime.__alcorOrderTimer.unref();
}
