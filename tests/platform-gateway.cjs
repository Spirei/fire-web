const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  Module = require("node:module"),
  ts = require("typescript");
const root = path.resolve(__dirname, ".."),
  original = Module._resolveFilename;
Module._resolveFilename = function (id, parent, ...rest) {
  return original.call(
    this,
    id.startsWith("@/") ? path.join(root, id.slice(2)) : id,
    parent,
    ...rest,
  );
};
require.extensions[".ts"] = (module, file) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
const {
  platformRequest,
  platformConfig,
} = require("../lib/platformTransport.ts");
const proxy = require("../app/api/[[...platform]]/route.ts");
const publicAssets = require("../app/assets/system/[name]/route.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-transport-"));
const socket = path.join(dir, "p.sock");
process.env.FIRE_PLATFORM_SOCKET = socket;
process.env.FIRE_PUBLIC_ORIGIN = "https://fire.example.invalid";
const seen = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: Buffer.concat(chunks),
  });
  res.setHeader("content-type", "application/json");
  res.setHeader("set-cookie", [
    "fire_session=fake; HttpOnly; Path=/",
    "other=value; Path=/",
  ]);
  if (req.url === "/api/not-a-declared-route") res.statusCode = 404;
  else if (req.method === "DELETE") res.statusCode = 405;
  res.end(JSON.stringify({ ok: true }));
});
(async () => {
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    const response = await platformRequest("/api/fire/tasks", {
      method: "POST",
      headers: {
        cookie: "fire_session=fake",
        host: "attacker.invalid",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
        origin: "https://fire.example.invalid",
        "x-csrf-token": "test",
        "x-simple-ledger-user": "ledger-owner",
        "x-alcor-expected-revision": "9",
        "content-type": "application/json",
      },
      body: new Response('{"request_id":"one"}').body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.getSetCookie().length, 2);
    await response.text();
    const actual = seen.at(-1);
    assert.equal(actual.headers.host, "fire.example.invalid");
    assert.equal(actual.headers["x-forwarded-host"], "fire.example.invalid");
    assert.equal(actual.headers["x-forwarded-proto"], "https");
    assert.equal(actual.headers["x-alcor-expected-revision"], "9");
    assert.equal(actual.headers.cookie, "fire_session=fake");
    assert.equal(actual.headers["x-simple-ledger-user"], "ledger-owner");
    assert.equal(actual.body.toString(), '{"request_id":"one"}');
    const count = seen.length;
    assert.equal(
      (
        await proxy.POST(
          new Request("https://fire.example.invalid/api/fire/tasks", {
            method: "POST",
            headers: { origin: "https://attacker.invalid" },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await proxy.DELETE(
          new Request("https://fire.example.invalid/api/fire/system/overview", {
            method: "DELETE",
            headers: { origin: "https://fire.example.invalid" },
          }),
        )
      ).status,
      405,
    );
    assert.equal(
      (
        await proxy.GET(
          new Request("https://fire.example.invalid/api/not-a-declared-route"),
        )
      ).status,
      404,
    );
    assert.equal(seen.length, count + 2);
    for (const prefix of ["/api/v1", "/api/v2", "/api/client"]) {
      for (const endpoint of ["login", "token", "revoke"]) {
        const pathname = prefix + (prefix === "/api/client" ? "/" : "/auth/") + endpoint;
        const native = await proxy.POST(new Request("https://fire.example.invalid" + pathname, {
          method: "POST", headers: { "content-type": "application/json" }, body: '{"client_id":"fire-ios"}',
        }));
        assert.equal(native.status, 200, "native credential requests without Origin reach the same authority");
        await native.text();
        assert.equal(seen.at(-1).url, pathname);
        assert.equal(seen.at(-1).headers.origin, undefined);
        assert.equal(seen.at(-1).headers.authorization, undefined);
        assert.equal(seen.at(-1).headers["x-forwarded-proto"], "https");
      }
    }
    const routed = await proxy.GET(
      new Request(
        "https://fire.example.invalid/api/fire/tasks/receipts/123?limit=1",
        { headers: { cookie: "fire_session=fake" } },
      ),
    );
    assert.equal(routed.status, 200);
    await routed.text();
    assert.equal(seen.at(-1).url, "/api/fire/tasks/receipts/123?limit=1");
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 128]);
    const upload = await proxy.POST(
      new Request("https://fire.example.invalid/api/app-packages", {
        method: "POST",
        headers: {
          origin: "https://fire.example.invalid",
          "content-type": "application/octet-stream",
          "content-length": String(binary.length),
          "x-file-name": "%E6%B5%8B%E8%AF%95.apk",
          "x-alcor-request-id": "00000000-0000-0000-0000-000000000123",
          "x-csrf-token": "test",
          cookie: "fire_session=fake",
        },
        body: binary,
      }),
    );
    assert.equal(upload.status, 200);
    await upload.text();
    const actualUpload = seen.at(-1);
    assert.deepEqual(actualUpload.body, binary);
    assert.equal(actualUpload.headers["content-length"], String(binary.length));
    assert.equal(actualUpload.headers["x-file-name"], "%E6%B5%8B%E8%AF%95.apk");
    assert.equal(
      actualUpload.headers["x-alcor-request-id"],
      "00000000-0000-0000-0000-000000000123",
    );
    assert.equal(actualUpload.headers["x-csrf-token"], "test");
    const fixed = await publicAssets.GET(
      new Request(
        "https://fire.example.invalid/assets/system/pwa-icon?size=180",
      ),
      { params: Promise.resolve({ name: "pwa-icon" }) },
    );
    assert.equal(fixed.status, 200);
    await fixed.text();
    assert.equal(seen.at(-1).url, "/assets/system/pwa-icon?size=180");
    const publicCount = seen.length;
    assert.equal(
      (
        await publicAssets.GET(
          new Request(
            "https://fire.example.invalid/assets/system/not-registered",
          ),
          { params: Promise.resolve({ name: "not-registered" }) },
        )
      ).status,
      404,
    );
    assert.equal(seen.length, publicCount);
    await assert.rejects(() => platformRequest("//attacker.invalid/api"));
    await assert.rejects(() => platformRequest("/\\attacker.invalid/api"));
    process.env.FIRE_PUBLIC_ORIGIN = "https://name:secret@fire.example.invalid";
    assert.throws(platformConfig);
    for (const version of [1,2]) {
      const failed = await proxy.POST(new Request(`https://fire.example.invalid/api/v${version}/auth/token`, {
        method: "POST", headers: { "content-type": "application/json" }, body: '{}',
      }));
      assert.equal(failed.status,503);
      assert.equal(failed.headers.get("x-alcor-api-version"),String(version));
      assert.equal(failed.headers.get("retry-after"),"3");
      assert(failed.headers.get("x-request-id"));
      assert.equal(failed.headers.get("vary"),"Authorization");
      assert.deepEqual(await failed.json(),{code:50001,message:"平台服务暂不可用，请稍后核对结果",data:null});
    }
    const head = await proxy.HEAD(new Request("https://fire.example.invalid/api/v2/auth/config",{method:"HEAD"}));
    assert.equal(head.status,503);assert.equal(await head.text(),"");
    process.env.FIRE_PUBLIC_ORIGIN = "https://fire.example.invalid";
    assert(
      !Object.hasOwn(require("../package.json").dependencies, "better-sqlite3"),
    );
    for (const file of [
      "db.ts",
      "postgresDatabase.ts",
      "postgresWorker.cjs",
      "postgresSql.ts",
      "postgresRuntime.ts",
    ])
      assert(
        !fs.existsSync(path.join(root, "lib", file)),
        file + " must be removed",
      );
    console.log(
      "PASS Fire 内部传输：Unix socket、固定主机、会话与修订号、Cookie、来源限制、后端方法校验与无 SQLite/同步 PG 桥",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
