#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localOptions, launcherTitle } from "./local-options.mjs";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const env = { ...process.env, PATH: [resolve(homedir(), ".local/bin"), "/opt/homebrew/bin", process.env.PATH || ""].join(delimiter) };
let child, stopping = false;
let exitCode = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; child?.kill(signal); });
async function run(command, args) {
  if (stopping) return;
  await new Promise((yes, no) => {
    child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", no);
    child.once("exit", (code, signal) => { child = undefined; if (stopping || code === 0) yes(); else no(new Error(`${command} 退出：${code ?? signal}`)); });
  });
}
try {
  const options = localOptions(process.argv.slice(2));
  // PM2's long absolute process title is truncated by macOS; keep an exact project binding.
  process.title = launcherTitle(root);
  await new Promise((yes, no) => {
    const probe = createServer();
    probe.once("error", () => no(new Error(`${options.host}:${options.port} 无法监听，请核对本机地址和端口占用`)));
    probe.listen(options.port, options.host, () => probe.close(yes));
  });
  if (!existsSync(resolve(root, "node_modules"))) await run("npm", ["ci"]);
  await run("npm", ["run", "build"]);
  await run("uv", ["run", "--locked", "python", "tools/local-runtime.py", ...options.runtimeArgs]);
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  // PM2 keeps an IPC channel open. A finished launcher must exit explicitly,
  // otherwise a rejected startup can remain "online" without an API child.
  process.exit(exitCode);
}
