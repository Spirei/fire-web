import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import nextEnv from "@next/env";
import { pythonExecutable } from "./fire-runtime.mjs";
const root = path.resolve(import.meta.dirname, "..");
const [mode, ...args] = process.argv.slice(2);
if (mode !== "test-backend") nextEnv.loadEnvConfig(root, mode === "dev");
// Homebrew's Cairo is outside macOS dyld defaults; Python SVG rendering needs it.
if (process.platform === "darwin" && !process.env.DYLD_FALLBACK_LIBRARY_PATH) {
  const cairo = ["/opt/homebrew/lib", "/usr/local/lib"].filter((dir) =>
    fs.existsSync(path.join(dir, "libcairo.2.dylib")),
  );
  if (cairo.length) process.env.DYLD_FALLBACK_LIBRARY_PATH = cairo.join(":");
}
const backend = path.resolve(
  process.env.FIRE_PLATFORM_ROOT || path.join(root, "platform"),
);
const python = pythonExecutable(backend);
if (!fs.existsSync(path.join(backend, "backend/alcor_api/main.py")))
  throw new Error("Fire 内置后端源码缺失");
if (
  ["validate-config", "inspect-database", "check-schema", "migrate"].includes(
    mode,
  )
) {
  const child = spawn(
    python,
    [path.join(root, "scripts/fire_platform.py"), mode, ...args],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (mode === "test-backend") {
  const child = spawn(python, ["-m", "pytest", ...args], {
    cwd: backend,
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: path.join(backend, "backend") },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  if (!["dev", "start"].includes(mode)) throw new Error("运行方式无效");
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = Number(
    portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 3000,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口无效");
  if (!process.env.FIRE_PUBLIC_ORIGIN) {
    if (mode === "start") throw new Error("请配置 Fire 对外访问地址");
    process.env.FIRE_PUBLIC_ORIGIN = `http://localhost:${port}`;
  }
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "fire-"));
  fs.chmodSync(runtime, 0o700);
  const socket = path.join(runtime, "platform.sock");
  if (Buffer.byteLength(socket) > 100)
    throw new Error("临时目录过长，请设置较短的 TMPDIR");
  const env = {
    ...process.env,
    FIRE_PLATFORM_ROOT: backend,
    FIRE_PLATFORM_SOCKET: socket,
    FIRE_SOFTWARE_VERSION: JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).version,
    NEXT_DIST_DIR:
      mode === "dev"
        ? process.env.NEXT_DIST_DIR || ".next-dev"
        : process.env.NEXT_DIST_DIR || ".next",
  };
  const children = [];
  let closing = false;
  process.on("exit", () =>
    fs.rmSync(runtime, { recursive: true, force: true }),
  );
  const stop = (code) => {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      fs.rmSync(runtime, { recursive: true, force: true });
      process.exit(code);
    }, 3000).unref();
  };
  const run = (command, argv) => {
    const child = spawn(command, argv, { cwd: root, env, stdio: "inherit" });
    children.push(child);
    child.on("error", () => stop(1));
    child.on("exit", (code) => {
      if (!closing) stop(code ?? 1);
    });
    return child;
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
  run(python, [path.join(root, "scripts/fire_platform.py"), "serve"]);
  const ready = () =>
    new Promise((resolve) => {
      const request = http.get(
        {
          socketPath: socket,
          path: "/health/ready",
          headers: { host: new URL(env.FIRE_PUBLIC_ORIGIN).host },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.setTimeout(1000, () => request.destroy());
      request.on("error", () => resolve(false));
    });
  let up = false;
  for (let attempt = 0; attempt < 180 && !closing; attempt++) {
    if (await ready()) {
      up = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!up) stop(1);
  else {
    if (process.env.FIRE_WORKER === "on")
      run(python, [path.join(root, "scripts/fire_platform.py"), "worker"]);
    run(process.execPath, [
      path.join(root, "node_modules/next/dist/bin/next"),
      mode,
      "-H",
      process.env.FIRE_BIND_HOST || "0.0.0.0",
      "-p",
      String(port),
    ]);
  }
}
