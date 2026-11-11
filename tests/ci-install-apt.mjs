import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/ci-install-apt.sh");
const fixture = mkdtempSync(join(tmpdir(), "ci-apt-test-"));
try {
  const mocks = {
    "dpkg-query": `
const installed = (process.env.MOCK_INSTALLED || "").split(",");
if (!installed.includes(process.argv.at(-1))) process.exit(1);
process.stdout.write("install ok installed");`,
    "lsb_release": 'process.stdout.write("noble\\n");',
    "dpkg": 'process.stdout.write("amd64\\n");',
    "timeout": `
const assert = require("node:assert/strict");
assert.equal(process.argv[2], "10s", "DNS checks must have a hard deadline");
const result = require("node:child_process").spawnSync(process.argv[3], process.argv.slice(4), { stdio: "inherit" });
process.exit(result.status ?? 1);`,
    "getent": `
const host = process.argv.at(-1);
require("node:fs").appendFileSync(process.env.MOCK_DNS_LOG, host + "\\n");
if (process.env.MOCK_DNS === "all" || (process.env.MOCK_DNS === "ubuntu" && host.endsWith("ubuntu.com"))) process.exit(2);
console.log("192.0.2.1 STREAM " + host);`,
    "apt-get": `
const fs = require("node:fs");
const args = process.argv.slice(2);
const sourceArg = args.find(arg => arg.startsWith("Dir::Etc::sourcelist="));
const source = sourceArg?.slice("Dir::Etc::sourcelist=".length);
const primary = source?.endsWith("/ubuntu.list");
const phase = args.includes("update") ? "update" : "install";
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({
  args, phase, source, sources: source && fs.readFileSync(source, "utf8")
}) + "\\n");
if (process.env.MOCK_FAILURE === "all" ||
    (primary && process.env.MOCK_FAILURE === phase)) {
  console.error("Temporary failure resolving 'azure.archive.ubuntu.com'");
  process.exit(100);
}`,
  };
  for (const [name, body] of Object.entries(mocks)) {
    writeFileSync(join(fixture, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  }
  function run(failure = "", installed = "", dns = "") {
    const log = join(fixture, "calls.jsonl");
    const dnsLog = join(fixture, "dns.log");
    writeFileSync(log, "");
    writeFileSync(dnsLog, "");
    const result = spawnSync("bash", [script, "redis-server", "libcairo2"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fixture + ":" + process.env.PATH,
        MOCK_LOG: log,
        MOCK_DNS_LOG: dnsLog,
        MOCK_FAILURE: failure,
        MOCK_INSTALLED: installed,
        MOCK_DNS: dns,
      },
    });
    assert.ifError(result.error);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    for (const call of calls) {
      assert(call.args.includes("APT::Update::Error-Mode=any"), "index failures must fail update");
      assert(call.args.includes("Acquire::Retries=2"), "network retries must be bounded");
      assert(call.args.includes("Acquire::http::Timeout=15"));
      assert(call.args.includes("Acquire::https::Timeout=15"));
      assert(call.args.includes("Dir::Etc::sourceparts=-"), "runner mirror redirects must be disabled");
      assert(call.args.some(arg => arg.startsWith("Dir::State::lists=")), "each mirror must isolate old indexes");
      assert.equal(existsSync(call.source), false, "temporary sources must be cleaned up on success or failure");
      assert.equal(call.sources.trim().split("\n").length, 3);
      for (const line of call.sources.trim().split("\n")) {
        assert.match(line, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
      }
      assert(!/azure|trusted=yes|allow-insecure/.test(call.sources));
    }
    return { ...result, calls, dns: readFileSync(dnsLog, "utf8").trim().split("\n").filter(Boolean) };
  }

  assert.equal(spawnSync("bash", [script], { encoding: "utf8" }).status, 2);
  const ready = run("all", "redis-server,libcairo2");
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.calls.length, 0, "installed packages must not require network");

  const healthy = run("", "libcairo2");
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.deepEqual(healthy.calls.map(call => call.phase), ["update", "install"]);
  assert(healthy.calls.every(call => call.source.endsWith("/ubuntu.list")), "healthy official archive needs no fallback");
  assert.match(healthy.calls[0].sources, /https:\/\/archive\.ubuntu\.com\/ubuntu noble /);
  assert.match(healthy.calls[0].sources, /https:\/\/archive\.ubuntu\.com\/ubuntu noble-updates /);
  assert.match(healthy.calls[0].sources, /https:\/\/security\.ubuntu\.com\/ubuntu noble-security /);
  assert(healthy.calls[1].args.includes("redis-server"));
  assert(!healthy.calls[1].args.includes("libcairo2"), "installed library must not be upgraded");

  // Cover both failure points: a bad index must never lead to a stale-list install,
  // and a mirror that fails only on .deb downloads must also switch sources.
  for (const failure of ["update", "install"]) {
    const result = run(failure);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.phase), failure === "update"
      ? ["update", "update", "install"] : ["update", "install", "update", "install"]);
    const fallback = result.calls.filter(call => call.source.endsWith("/kernel.list"));
    assert.deepEqual(fallback.map(call => call.phase), ["update", "install"]);
    assert.equal(fallback[0].source, fallback[1].source);
    assert.notEqual(result.calls[0].source, fallback[0].source);
    assert.notEqual(result.calls[0].args.find(arg => arg.startsWith("Dir::State::lists=")), fallback[0].args.find(arg => arg.startsWith("Dir::State::lists=")));
    for (const call of fallback) {
      assert.match(call.sources, /https:\/\/mirrors\.edge\.kernel\.org\/ubuntu noble /);
      assert.match(call.sources, /https:\/\/mirrors\.edge\.kernel\.org\/ubuntu noble-updates /);
      assert.match(call.sources, /https:\/\/mirrors\.edge\.kernel\.org\/ubuntu noble-security /);
    }
  }
  // Real runner regression: all ubuntu.com hosts fail DNS together. The
  // independent mirror must still install packages without waiting for apt.
  const domainOutage = run("", "", "ubuntu");
  assert.equal(domainOutage.status, 0, domainOutage.stderr);
  assert.deepEqual(domainOutage.dns, ["archive.ubuntu.com", "mirrors.edge.kernel.org"]);
  assert.deepEqual(domainOutage.calls.map(call => call.phase), ["update", "install"]);
  assert(domainOutage.calls.every(call => call.source.endsWith("/kernel.list")));
  const dnsOutage = run("", "", "all");
  assert.equal(dnsOutage.status, 100);
  assert.equal(dnsOutage.calls.length, 0, "unresolvable mirrors must not start apt retries");
  const unavailable = run("all");
  assert.equal(unavailable.status, 100, "total network failure must keep blocking publication");
  assert.deepEqual(unavailable.calls.map(call => call.phase), ["update", "update"]);
  assert.equal(existsSync(unavailable.calls[1].source), false, "failure must also clean temporary sources");

  const workflow = readFileSync(join(root, ".github/workflows/docker-publish.yml"), "utf8");
  assert.match(workflow, /run: sudo bash scripts\/ci-install-apt\.sh libcairo2/);
  assert.match(workflow, /run: sudo bash scripts\/ci-install-apt\.sh redis-server libcairo2/);
  console.log("CI apt recovery passed: installed packages, signed/isolated mirrors, correlated DNS failure, index/download fallback and total outage.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
