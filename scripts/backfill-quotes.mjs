#!/usr/bin/env node
/**
 * 素材库股票行情回填：为 price 缺失的股票批量拉取腾讯行情（现价 + 涨跌幅）并写入数据库。
 *
 * 覆盖市场：
 *   - US / HK / CN：腾讯标准前缀（us / hk / sh / sz / bj）
 *   - JP：jp{code}（去掉 .T 后缀，如 7203.T → jp7203）
 *   - KR：kr{code}（去掉 .KS / .KQ 后缀，如 005930.KS → kr005930）
 *
 * 用法：node scripts/backfill-quotes.mjs [N]
 *   N 可选：本次最多处理条数（默认全部缺失项）
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const LIMIT = Number(process.argv[2]) || Infinity;
const QUOTE_URL = "https://qt.gtimg.cn/q=";
const CHUNK = 45;

function tencentSymbol(market, code) {
  const c = String(code).trim().toUpperCase().replace(/\.(AM|N|OQ|PS|K)$/, "");
  if (market === "US") return c ? `us${c}` : "";
  if (market === "HK") return c ? `hk${c.padStart(5, "0")}` : "";
  if (market === "CN") {
    if (/^(4|8|920)/.test(c)) return `bj${c}`;
    if (/^[69]/.test(c)) return `sh${c}`;
    if (/^[0-3]/.test(c)) return `sz${c}`;
    return `bj${c}`;
  }
  if (market === "JP") return c ? `jp${c.replace(/\.T$/, "")}` : "";
  if (market === "KR") return c ? `kr${c.replace(/\.(KS|KQ)$/, "")}` : "";
  return "";
}

async function fetchBatch(symbols) {
  const res = await fetch(QUOTE_URL + symbols.join(","), {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`行情接口返回 ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder("gbk").decode(buffer);
  const out = new Map();
  for (const line of text.split(";")) {
    const m = line.match(/^v_([^=]+)="([^"]*)"/);
    if (!m) continue;
    const fields = m[2].split("~");
    if (fields.length < 35) continue;
    const price = Number(fields[3]);
    if (!price) continue;
    out.set(m[1], { price, changePct: Number(fields[32]) || 0 });
  }
  return out;
}

async function main() {
  const db = new Database(path.join(ROOT, "data", "fire.db"));
  const rows = db
    .prepare("SELECT id, market, code FROM assets WHERE type = 'stock' AND price IS NULL ORDER BY market, code")
    .all();
  const todo = rows.slice(0, LIMIT);
  const upd = db.prepare("UPDATE assets SET price = ?, change_pct = ?, updated_at = ? WHERE id = ?");
  let updated = 0;
  let noMatch = 0;
  const now = new Date().toISOString();

  // 腾讯行情接口当前每次请求只返回第一条（批量失效），全部逐条请求
  let done = 0;
  for (const r of todo) {
    const sym = tencentSymbol(r.market, r.code);
    if (sym) {
      const q = (await fetchBatch([sym]).catch(() => new Map())).get(sym);
      if (q) {
        upd.run(q.price, q.changePct, now, r.id);
        updated++;
      } else {
        noMatch++;
      }
    } else {
      noMatch++;
    }
    done++;
    if (done % 10 === 0) process.stdout.write(`\r回填 ${done}/${todo.length} · 成功 ${updated} · 无匹配 ${noMatch}`);
  }
  console.log(`\n完成：待回填 ${todo.length}，成功 ${updated}，无匹配 ${noMatch}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
