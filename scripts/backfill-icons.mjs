/* 独立补漏脚本：串行、慢速为缺失图标的股票下载图标（绕开 dev server 后台任务与微牛限流）
 * 用法：node scripts/backfill-icons.mjs [最多处理 N 只，默认全部]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const WEBULL_SEARCH = "https://quotes-gw.webullfintech.com/api/search/pc/tickers";
const WEBULL_ICON = (tid) => `https://quotes-static.webullfintech.com/ticker-icon/${tid}.png`;
const PARQET_ICON = (code) => `https://assets.parqet.com/logos/symbol/${code}`;
const REGION = { US: 6, HK: 2, CN: 1 };
const ASSET_DIR = path.join(process.cwd(), "public", "uploads", "asset");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normCode(market, code) {
  const c = code.trim().toUpperCase();
  if (market === "HK") return c.padStart(5, "0");
  if (market === "JP") return c.endsWith(".T") ? c : `${c}.T`;
  if (market === "KR") return c.endsWith(".KS") ? c : `${c}.KS`;
  return c;
}
function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|\s()（）[\]{}]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "stock";
}
function sniffExt(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  const head = buf.toString("latin1", 0, Math.min(buf.length, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (head.toLowerCase().startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return null;
}

async function searchWebull(code, regionId) {
  const url = `${WEBULL_SEARCH}?keyword=${encodeURIComponent(code)}&regionIds=${regionId}&pageIndex=1&pageSize=20`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const list = data?.data ?? [];
      if (list.length === 0) { await sleep(1500 * (a + 1)); continue; }
      const exact = list.find(
        (t) =>
          t.template === "stock" &&
          ((t.symbol || "").toUpperCase() === code ||
            (t.disSymbol || "").toUpperCase() === code ||
            (t.symbol || "").toUpperCase().replace(/^0+/, "") === code.replace(/^0+/, ""))
      );
      const hit = exact ?? list.find((t) => t.template === "stock");
      if (hit && typeof hit.tickerId === "number") return hit.tickerId;
    } catch {}
    await sleep(1000 * (a + 1));
  }
  return null;
}

async function downloadIcon(url, market, code, name) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!(type.startsWith("image/") || type === "application/octet-stream")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const ext = sniffExt(buf) ?? (type.includes("svg") ? "svg" : type.includes("webp") ? "webp" : type.includes("png") ? "png" : null);
    if (!ext) return null;
    const dir = path.join(ASSET_DIR, "stock", market);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${sanitizeName(name)}${code}${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return `/uploads/asset/stock/${market}/${encodeURIComponent(filename)}`;
  } catch {
    return null;
  }
}

async function resolveIcon(market, code, name) {
  const norm = normCode(market, code);
  if (market === "US" || market === "HK" || market === "CN") {
    let tid = await searchWebull(norm, REGION[market]);
    if (!tid && name) tid = await searchWebull(name, REGION[market]);
    if (tid) {
      const local = await downloadIcon(WEBULL_ICON(tid), market, norm, name);
      if (local) return local;
    }
  } else {
    const local = await downloadIcon(PARQET_ICON(norm), market, norm, name);
    if (local) return local;
  }
  return null;
}

const db = new Database(path.join(process.cwd(), "data", "fire.db"));
const rows = db.prepare("SELECT market, code, name FROM assets WHERE type='stock' AND (url='' OR url IS NULL) ORDER BY market").all();
const limit = Number(process.argv[2]) || rows.length;
const todo = rows.slice(0, limit);
console.log(`待补图标 ${todo.length} 只（共缺 ${rows.length}）`);
const upd = db.prepare("UPDATE assets SET url=?, updated_at=? WHERE type='stock' AND market=? AND code=?");
let ok = 0;
for (let i = 0; i < todo.length; i++) {
  const r = todo[i];
  const local = await resolveIcon(r.market, r.code, r.name);
  if (local) {
    upd.run(local, new Date().toISOString(), r.market, r.code);
    ok++;
    process.stdout.write(`✓ ${r.market} ${r.code} ${r.name}\n`);
  } else if ((i + 1) % 20 === 0) {
    process.stdout.write(`… ${i + 1}/${todo.length}（成功 ${ok}）\n`);
  }
  await sleep(3000); // 串行慢速，避免微牛限流
}
const remain = db.prepare("SELECT COUNT(*) c FROM assets WHERE type='stock' AND (url='' OR url IS NULL)").get().c;
console.log(`完成：本次补 ${ok} 只，剩余缺失 ${remain}`);
