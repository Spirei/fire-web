import { backgroundMode, verifyWorkerIdentity } from "../lib/backgroundMode";

async function main() {
  if (backgroundMode() !== "external") throw Error("独立后台任务需要显式启用 external 模式");
  if (process.argv.slice(2).some(arg => arg !== "--check")) throw Error("后台任务参数无效");
  if (!process.argv.includes("--check") && process.env.NODE_ENV !== "production") throw Error("实际后台任务仅允许明确的生产运行模式");
  // No business module, schema initializer, task or provider is loaded before target verification.
  const { readPostgresRuntime, runtimePostgresDatabase } = await import("../lib/postgresRuntime");
  const config = readPostgresRuntime();
  verifyWorkerIdentity(config?.migrationId, process.env.FIRE_WORKER_MIGRATION_ID);
  const database = runtimePostgresDatabase();
  if (!database) throw Error("独立后台任务只允许已完成切换的 PostgreSQL");
  try {
    if (process.argv.includes("--check")) { console.log("后台任务数据库核对通过；未启动任务"); return; }
    // Session lock is held on the same connection used by business transactions.
    const locked = database.raw("SELECT pg_try_advisory_lock(hashtext(current_database()||':alcor-independent-worker')) AS locked").rows[0]?.locked;
    if (locked !== true) throw Error("已有独立后台任务进程运行");
    const [{ priceAlertTick }, { orderExecutionTick }, { tickFeedScheduler }] = await Promise.all([
      import("../lib/priceAlertWorker"), import("../lib/orderExecutionWorker"), import("../lib/feedGeneration")
    ]);
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => { stopped = true; wake?.(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    let feedAt = 0;
    console.log("独立后台任务已启动");
    while (!stopped && database.open) {
      const jobs: (() => Promise<unknown>)[] = [priceAlertTick, orderExecutionTick];
      if (Date.now() >= feedAt) { jobs.push(tickFeedScheduler); feedAt = Date.now() + 60_000; }
      for (const job of jobs) {
        if (stopped || !database.open) break;
        try { await job(); } catch { console.warn("后台任务本轮失败；保留原任务与回执"); }
      }
      if (!stopped && database.open) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 5000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    if (!stopped) throw Error("后台任务数据库连接已中断");
  } finally { database.close(); }
}
main().catch(() => { console.error("独立后台任务未就绪或已停止，请核对运行模式、数据库标识与连接状态"); process.exitCode = 1; });
