import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareSmokeAccount, readSmokeAccount } from "../scripts/smoke-account.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fire-smoke-account-"));
const file = path.join(temp, "account.json");
const originalFetch = global.fetch;
const calls = [];
global.fetch = async (url, options) => {
  calls.push({ url, options });
  if (url.endsWith("/logout")) return Response.json({ ok: true });
  return Response.json({ user: { username: "fixture_smoke", role: "user", isTest: true } }, { status: url.endsWith("/register") ? 201 : 200, headers: { "set-cookie": "fire_session=fixture; HttpOnly; Path=/" } });
};
try {
  const created = await prepareSmokeAccount(file, "http://localhost:3000", "fixture_smoke");
  assert.equal(created.created, true);
  const content = await fs.readFile(file, "utf8"), account = JSON.parse(content);
  assert(account.password.length >= 32 && /[A-Za-z]/.test(account.password) && /\d/.test(account.password));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(calls[0].options.body).isTest, true);
  assert.equal(calls[1].url, "http://localhost:3000/api/auth/logout");
  console.log("PASS independent registration persists a random private credential and closes its session");

  calls.length = 0;
  const reused = await prepareSmokeAccount(file, "http://127.0.0.1:3000");
  assert.equal(reused.created, false);
  assert.equal(reused.username, "fixture_smoke");
  assert.equal(calls.length, 2);
  assert(calls[0].url.endsWith("/login"));
  assert.equal(await fs.readFile(file, "utf8"), content);
  console.log("PASS later runs reuse the account across loopback aliases without registration or password reset");

  calls.length = 0;
  await assert.rejects(() => readSmokeAccount(file, "https://unrelated.example.test"), /目标地址不匹配/);
  await assert.rejects(() => prepareSmokeAccount(path.join(temp, "remote.json"), "https://unrelated.example.test"), /仅用于本地/);
  assert.equal(calls.length, 0);
  console.log("PASS foreign destinations are rejected before credentials can be transmitted");

  global.fetch = async () => Response.json({ error: "拒绝登录" }, { status: 401 });
  await assert.rejects(() => prepareSmokeAccount(file, "http://localhost:3000"), /登录失败/);
  assert.equal(await fs.readFile(file, "utf8"), content);
  console.log("PASS a failed login never replaces saved credentials or resets an existing account");

  const loginBody = path.join(temp, "login.json"), wrongBody = path.join(temp, "wrong.json");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/smoke-account.mjs"), "--login-body", loginBody, "--wrong-body", wrongBody], {
    cwd: root, encoding: "utf8", env: { ...process.env, BASE: "http://localhost:3000", SMOKE_ACCOUNT_FILE: file }
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), "fixture_smoke");
  assert(!cli.stdout.includes(account.password) && !cli.stderr.includes(account.password));
  assert.equal(JSON.parse(await fs.readFile(loginBody, "utf8")).password, account.password);
  assert.notEqual(JSON.parse(await fs.readFile(wrongBody, "utf8")).password, account.password);
  assert.equal((await fs.stat(loginBody)).mode & 0o777, 0o600);
  console.log("PASS CLI passes credentials through private files without putting passwords in output or arguments");
} finally {
  global.fetch = originalFetch;
  await fs.rm(temp, { recursive: true, force: true });
}
