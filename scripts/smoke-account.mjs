import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const defaultAccountFile = path.join(root, "data/smoke-account.json");
export function originKey(base) {
  const url = new URL(base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("测试地址无效");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { origin: url.origin, key: loopback ? `${url.protocol}//localhost:${url.port || (url.protocol === "https:" ? "443" : "80")}` : url.origin, loopback };
}
export async function readSmokeAccount(file, base) {
  let account;
  try { account = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw new Error("缺少有效测试账号配置，请用 SMOKE_ACCOUNT_FILE 指定独立实例的账号文件"); }
  if (account.version !== 1 || typeof account.username !== "string" || typeof account.password !== "string" || !/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(account.username) || account.password.length < 8 || account.password.length > 128) throw new Error("测试账号配置无效");
  if (typeof account.origin !== "string" || originKey(account.origin).key !== originKey(base).key) throw new Error("测试账号与目标地址不匹配，请使用对应的 SMOKE_ACCOUNT_FILE");
  return account;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const base = process.env.BASE || "http://localhost:3000";
    const file = process.env.SMOKE_ACCOUNT_FILE || defaultAccountFile;
      const index = process.argv.indexOf("--login-body");
      const wrongIndex = process.argv.indexOf("--wrong-body");
      if (index < 0 || !process.argv[index + 1] || wrongIndex < 0 || !process.argv[wrongIndex + 1]) throw new Error("缺少登录请求文件参数");
      const account = await readSmokeAccount(file, base);
      await fs.writeFile(process.argv[index + 1], JSON.stringify({ username: account.username, password: account.password }), { mode: 0o600 });
      await fs.writeFile(process.argv[wrongIndex + 1], JSON.stringify({ username: account.username, password: randomBytes(24).toString("hex") }), { mode: 0o600 });
      console.log(account.username);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "测试账号配置失败"); process.exitCode = 1;
  }
}
