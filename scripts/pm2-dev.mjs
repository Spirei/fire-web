import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import nextEnv from "@next/env";

const root = fileURLToPath(new URL("../", import.meta.url));
nextEnv.loadEnvConfig(root, true);
const name = process.env.FIRE_PM2_NAME || "fire";
const args = process.argv.slice(2),
  portIndex = args.findIndex((x) => x === "--port" || x === "-p");
const port = Number(
  portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 3000,
);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("端口无效");
process.env.PORT = String(port);
const config = fileURLToPath(
  new URL("../ecosystem.config.cjs", import.meta.url),
);
const pm2 = (args, capture = false) =>
  execFileSync("pm2", args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
const processes = () => JSON.parse(pm2(["jlist"], true));
const pause = () => new Promise((resolve) => setTimeout(resolve, 1500));

try {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    console.log(
      `启动目录：${root}；源码版本：${git(["rev-parse", "--short", "HEAD"])}`,
    );
    const pending = git([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ".",
      ":!data",
    ]);
    if (pending) console.warn("本地存在未提交源码，运行内容可能与线上不同。");
    const behind = Number(
      git(["rev-list", "--count", "HEAD..refs/remotes/origin/main"]),
    );
    if (behind)
      console.warn(
        `本地落后已获取的 origin/main ${behind} 个提交，请核对后同步。`,
      );
  } catch {
    console.warn("无法核对 Git 版本，请手动确认运行目录和源码版本。");
  }
  // Do not mistake another service on the selected port for this application's readiness.
  const occupied = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
  const existing = processes().find((p) => p.name === name);
  if (
    occupied &&
    !(
      existing?.pm2_env.status === "online" &&
      existing.pm2_env.pm_cwd.replace(/\/$/, "") === root.replace(/\/$/, "")
    )
  ) {
    throw new Error(
      `端口 ${port} 已被其他服务使用，请指定其他端口；不会结束其他服务。`,
    );
  }
  // PM2 may retain the old cwd when restarting an existing name with a config.
  if (
    existing &&
    existing.pm2_env.pm_cwd.replace(/\/$/, "") !== root.replace(/\/$/, "")
  ) {
    throw new Error(
      "同名进程来自其他目录，请通过 FIRE_PM2_NAME 使用独立名称；不会替换其他服务。",
    );
  }
  pm2(["startOrRestart", config, "--only", name, "--update-env"]);
  const deadline = Date.now() + 120000;
  let lastError = "网页尚未就绪";
  while (Date.now() < deadline) {
    const app = processes().find((p) => p.name === name);
    if (!app || ["errored", "stopped"].includes(app.pm2_env.status)) {
      throw new Error("fire 进程已停止");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      const html = await response.text();
      if (!response.ok || !html.includes("<html"))
        throw new Error(`网页响应异常：HTTP ${response.status}`);
      await pause();
      const current = processes().find((p) => p.name === name);
      if (current?.pid !== app.pid || current?.pm2_env.status !== "online") {
        throw new Error("检查期间进程发生重启");
      }
      pm2(["save"]);
      console.log(`网页已就绪：http://localhost:${port}（PM2 配置已保存）`);
      process.exit(0);
    } catch (error) {
      lastError = error.message;
    }
    await pause();
  }
  throw new Error(`等待网页就绪超时：${lastError}`);
} catch (error) {
  console.error(`启动检查失败：${error.message}`);
  console.error("查看原因：pm2 logs fire --lines 60 --nostream");
  process.exitCode = 1;
}
