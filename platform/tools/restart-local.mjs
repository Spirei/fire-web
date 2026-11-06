#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localOptions, ownedRuntimeCommand, ownedLauncherCommand } from "./local-options.mjs";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const execute = promisify(execFile);
const env = { ...process.env, PATH: [resolve(homedir(), ".local/bin"), "/opt/homebrew/bin", process.env.PATH || ""].join(delimiter) };
const checkOnly = process.argv.includes("--check");
let options;
const lock = resolve(root, ".local/runtime.lock");
async function command(file, args, optional = false) {
  try {
    return (await execute(file, args, { cwd: root, env, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    if (optional && error.code === 1) return "";
    throw new Error(`${file} 执行失败；未接管未知进程`);
  }
}
async function ownedRuntime(pid) {
  const value = await command("ps", ["-p", String(pid), "-o", "command="], true);
  if (!value) return false;
  const expected = resolve(root, ".venv/bin/python") + " tools/local-runtime.py";
  const cwd = await command("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (!ownedRuntimeCommand(value, expected) || !cwd.split("\n").includes("n" + root))
    throw new Error("运行锁由未确认的进程持有，已停止操作");
  return true;
}
async function runtimePids() {
  if (!existsSync(lock)) return [];
  if (realpathSync(lock) !== lock) throw new Error("运行锁路径不正确，已停止操作");
  const output = await command("lsof", ["-t", "--", lock], true);
  const pids = [...new Set(output.split(/\s+/).filter(Boolean).map(Number))];
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("运行锁进程不正确");
    await ownedRuntime(pid);
  }
  return pids;
}
async function isOwnedListener() {
  const runtimes = await runtimePids();
  const output = await command("lsof", ["-nP", "-t", `-iTCP:${options.port}`, "-sTCP:LISTEN"], true);
  for (const value of output.split(/\s+/).filter(Boolean)) {
    let pid = Number(value);
    for (let depth = 0; depth < 5 && pid > 1; depth++) {
      if (runtimes.includes(pid)) return true;
      pid = Number(await command("ps", ["-p", String(pid), "-o", "ppid="], true));
    }
  }
  return false;
}
try {
  options = localOptions(process.argv.slice(2).filter((arg) => arg !== "--check"));
  env.ALCOR_LOCAL_ARGS = JSON.stringify(options.runtimeArgs);
  // These commands expose only the named process, not the environment of every PM2 app.
  const description = await command("pm2", ["describe", "alcor-api"], true);
  const managedPids = (await command("pm2", ["pid", "alcor-api"], true)).split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number).filter((pid) => pid > 1);
  if (description) {
    const plain = description.replace(/\x1b\[[0-9;]*m/g, "");
    const paths = plain.split("\n").filter((line) => line.includes("script path"));
    if (paths.length !== 1 || !paths[0].includes(resolve(root, "tools/start-local.mjs")) || managedPids.length > 1)
      throw new Error("同名PM2项目不唯一或不属于当前目录，已停止操作");
  }
  for (const pid of managedPids) {
    const value = await command("ps", ["-p", String(pid), "-o", "command="], true);
    const cwd = await command("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (!ownedLauncherCommand(value, root) || !cwd.split("\n").includes("n" + root))
      throw new Error("同名PM2项目不属于当前目录，已停止操作");
  }
  const pids = await runtimePids();
  if (checkOnly) {
    console.log(JSON.stringify({ project: root, managedPm2Pids: managedPids, ownedLocalRuntimePids: pids, action: "read-only; no process changed" }));
    process.exit(0);
  }
  if (description) {
    console.log("正在停止本项目的 PM2 启动器…");
    await command("pm2", ["stop", "alcor-api"]);
  }
  for (const pid of await runtimePids()) {
    if (await ownedRuntime(pid)) process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === "ESRCH") break; throw error; }
      await new Promise((done) => setTimeout(done, 250));
    }
    try {
      process.kill(pid, 0);
      throw new Error("旧本地实例未完成退出，已取消启动");
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  console.log("正在构建并启动本地 AlcorApi…");
  await command("pm2", ["startOrRestart", "ecosystem.config.cjs", "--only", "alcor-api", "--update-env"]);
  const deadline = Date.now() + 60000;
  const expectedVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(options.origin + "/health/live", { signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      if (response.ok && data.version === expectedVersion) {
        const ready = await fetch(options.origin + "/health/ready", { signal: AbortSignal.timeout(1500) });
        if (ready.ok && await isOwnedListener()) {
          console.log(`已启动 v${data.version} Build ${data.build} · ${options.origin}`);
          process.exit(0);
        }
      }
    } catch { /* The new API may still be starting. */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("新版本地服务尚未就绪，请查看 pm2 logs alcor-api");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
