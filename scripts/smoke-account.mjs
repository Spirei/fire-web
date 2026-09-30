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
  catch { throw new Error("缺少有效测试账号配置，请先运行 npm run smoke:account"); }
  if (account.version !== 1 || typeof account.username !== "string" || typeof account.password !== "string" || !/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(account.username) || account.password.length < 8 || account.password.length > 128) throw new Error("测试账号配置无效");
  if (typeof account.origin !== "string" || originKey(account.origin).key !== originKey(base).key) throw new Error("测试账号与目标地址不匹配，请使用对应的 SMOKE_ACCOUNT_FILE");
  return account;
}
async function authenticate(origin, account, register) {
  const response = await fetch(`${origin}/api/auth/${register ? "register" : "login"}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: account.username, password: account.password, ...(register ? { isTest: true } : {}) }),
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("fire_session="))?.split(";")[0];
  const data = await response.json().catch(() => null);
  try {
    if (!response.ok || !data?.user || !cookie) throw new Error(register ? "测试账号注册失败，请检查本地服务和注册接口" : "测试账号登录失败，请检查独立账号配置");
    return data.user;
  } finally {
    if (cookie) await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  }
}
export async function prepareSmokeAccount(file, base, name = "fire_smoke") {
  const { origin, loopback } = originKey(base);
  if (!loopback) throw new Error("自动注册测试账号仅用于本地开发实例");
  try {
    const account = await readSmokeAccount(file, base);
    await authenticate(origin, account, false);
    return { username: account.username, created: false };
  } catch (error) {
    // Existing credentials must never be overwritten or reset after a failed login.
    if (await fs.stat(file).then(() => true, () => false)) throw error;
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(name)) throw new Error("测试账号名称需为 3–20 个字母、数字、下划线或中文");
  const account = { version: 1, origin, username: name, password: `Fire-${randomBytes(24).toString("base64url")}9`, createdAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Save before registration: even an interrupted response cannot lose the new credential.
  await fs.writeFile(file, JSON.stringify(account, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await authenticate(origin, account, true);
  return { username: account.username, created: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const base = process.env.BASE || "http://localhost:3000";
    const file = process.env.SMOKE_ACCOUNT_FILE || defaultAccountFile;
    if (process.argv.includes("--create")) {
      const result = await prepareSmokeAccount(file, base, process.env.SMOKE_USERNAME || "fire_smoke");
      console.log(`${result.created ? "已注册" : "已验证"}测试账号：${result.username}`);
      console.log(`凭据保存在本地 ${file}`);
    } else {
      const index = process.argv.indexOf("--login-body");
      const wrongIndex = process.argv.indexOf("--wrong-body");
      if (index < 0 || !process.argv[index + 1] || wrongIndex < 0 || !process.argv[wrongIndex + 1]) throw new Error("缺少登录请求文件参数");
      const account = await readSmokeAccount(file, base);
      await fs.writeFile(process.argv[index + 1], JSON.stringify({ username: account.username, password: account.password }), { mode: 0o600 });
      await fs.writeFile(process.argv[wrongIndex + 1], JSON.stringify({ username: account.username, password: randomBytes(24).toString("hex") }), { mode: 0o600 });
      console.log(account.username);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "测试账号配置失败"); process.exitCode = 1;
  }
}
