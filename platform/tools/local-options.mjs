import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function launcherTitle(root) {
  return (
    "alcor-api:" + createHash("sha256").update(root).digest("hex").slice(0, 16)
  );
}

export function ownedLauncherCommand(command, root) {
  return (
    command.split(/\s/)[0] === launcherTitle(root) ||
    command.includes(resolve(root, "tools/start-local.mjs"))
  );
}

export function localOptions(args, interfaces = networkInterfaces()) {
  let host = "127.0.0.1",
    port = 8088;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!["--lan", "--port"].includes(flag) || seen.has(flag) || !value)
      throw new Error("启动参数仅支持 --lan 本机局域网IP 和 --port 端口");
    seen.add(flag);
    if (flag === "--port") {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
        throw new Error("端口须为1024至65535的整数");
      port = Number(value);
    } else {
      const parts = value.split(".").map(Number);
      const privateIp =
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168);
      if (
        isIP(value) !== 4 ||
        !privateIp ||
        !Object.values(interfaces)
          .flat()
          .some((entry) => entry && entry.address === value && !entry.internal)
      )
        throw new Error("--lan 必须填写这台电脑当前的局域网IPv4地址");
      host = value;
    }
  }
  const runtimeArgs = [
    ...(host === "127.0.0.1" ? [] : ["--lan", host]),
    ...(port === 8088 ? [] : ["--port", String(port)]),
  ];
  return { host, port, origin: `http://${host}:${port}`, runtimeArgs };
}

export function ownedRuntimeCommand(command, expected) {
  if (command === expected || command === expected + " --vite") return true;
  if (!command.startsWith(expected + " ")) return false;
  try {
    const args = command.slice(expected.length + 1).split(" ");
    // A disconnected interface must not prevent stopping our own old runtime.
    const lan = args[0] === "--lan" ? args[1] : "";
    const parsed = localOptions(args, {
      owned: [{ address: lan, internal: false }],
    });
    return command === [expected, ...parsed.runtimeArgs].join(" ");
  } catch {
    return false;
  }
}
