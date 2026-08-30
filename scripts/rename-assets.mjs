#!/usr/bin/env node
/**
 * 素材文件命名规范化（market / crypto / metal / stock）
 *
 * 规范（AGENTS.md「素材库文件命名规范」）：
 *   - 市场图标：中文名+市场码（美股US.svg / 新加坡SG.svg）
 *   - 加密货币 / 贵金属：中文名+代码（比特币BTC.svg / 黄金GOLD.png）
 *   - 股票图标：中文名+股票代码（苹果AAPL.png / 寒武纪688256.png）
 *
 * 行为：
 *   1. 按 assets 表记录计算期望文件名（与 lib/upload.ts 的 assetFilename 同一清洗规则）；
 *   2. 磁盘文件名与期望不一致时重命名（fs.rename，不删除任何文件）并同步 assets.url / assets.name；
 *   3. 名称中的 HTML 实体（&amp; 等，来源为 HTML 抓取）一并解码，修复显示与文件名；
 *   4. URL 与磁盘路径比对先 decodeURIComponent，相对路径前缀为 /uploads/...（防误删教训）。
 *
 * 用法：node scripts/rename-assets.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const ASSET_ROOT = path.join(ROOT, "public", "uploads", "asset");
const DRY = process.argv.includes("--dry-run");

const MARKET_LABELS = {
  US: "美股",
  HK: "港股",
  CN: "A股",
  JP: "日股",
  KR: "韩股",
  SG: "新加坡",
  UK: "英国",
  DE: "德国",
  FR: "法国",
  AU: "澳大利亚",
  CA: "加拿大",
  IN: "印度",
  TW: "台湾",
  BR: "巴西"
};

/** A股除权/新股前缀名修正为规范全名（XD/DR 除权前缀 + 4 字截断名） */
const NAME_FIXES = {
  "stock:CN:001232": "嘉立创",
  "stock:CN:600060": "海信视像",
  "stock:CN:600104": "上汽集团",
  "stock:CN:600623": "华谊集团",
  "stock:CN:600839": "四川长虹",
  "stock:CN:600886": "国投电力",
  "stock:CN:601336": "新华保险",
  "stock:CN:601555": "东吴证券",
  "stock:CN:601918": "新集能源",
  "stock:CN:688187": "时代电气",
  "stock:CN:688425": "铁建重工",
  "stock:CN:688825": "长鑫科技",
  "stock:CN:689009": "九号公司-WD"
};

/** 解码 HTML 实体（名称来自 HTML 抓取，如 MS&amp;AD Insurance） */
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
}

/** 与 lib/upload.ts assetFilename 完全一致的清洗规则 */
function sanitizeName(name) {
  return String(name ?? "")
    .replace(/[\\/:*?"<>|\s()（）[\]{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 期望相对路径（相对 public/uploads/asset）与期望文件名 */
function expectedRel(row, ext) {
  const decodedName = decodeEntities(row.name);
  const fixedName = NAME_FIXES[row.id] || decodedName;
  let base;
  if (row.type === "market") {
    const label = MARKET_LABELS[row.market] || fixedName || row.market;
    base = sanitizeName(label) + String(row.market || "").toUpperCase();
  } else if (row.type === "broker") {
    // 券商图标：按券商名称命名（长桥证劵.png），无代码后缀
    base = sanitizeName(fixedName);
  } else {
    base = sanitizeName(fixedName) + String(row.code || "").toUpperCase();
  }
  const folder = row.type === "stock" ? `stock/${String(row.market || "").toUpperCase()}` : row.type;
  return { folder, base, fixedName };
}

function decodeRel(url) {
  const m = String(url || "").match(/^\/uploads\/asset\/(.+)$/);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i).toLowerCase() : "";
}

function main() {
  const db = new Database(path.join(ROOT, "data", "fire.db"));
  const rows = db
    .prepare("SELECT id, type, market, code, name, url FROM assets WHERE url IS NOT NULL AND url <> ''")
    .all();

  let renamed = 0;
  let nameFixed = 0;
  let missing = 0;
  let conflict = 0;
  const problems = [];

  // 预检：同一期望路径被多条记录引用时，跳过并提示（防止互相覆盖）
  const expectedCount = new Map();
  for (const row of rows) {
    const rel = decodeRel(row.url);
    if (!rel) continue;
    const ext = extOf(path.basename(rel));
    const { folder, base } = expectedRel(row, ext);
    const key = `${folder}/${base}${ext}`;
    expectedCount.set(key, (expectedCount.get(key) || 0) + 1);
  }

  for (const row of rows) {
    const rel = decodeRel(row.url);
    if (!rel) {
      problems.push(`[URL 异常] ${row.id}: ${row.url}`);
      continue;
    }
    const curFolder = path.posix.dirname(rel);
    const curFile = path.basename(rel);
    let ext = extOf(curFile);
    if (!ext) ext = "png"; // 历史 URL 缺扩展名（如 平安银行000001png）按图片默认补 .png
    const { folder, base, fixedName } = expectedRel(row, ext);
    const expectedFile = `${base}${ext}`;
    const expectedKey = `${folder}/${expectedFile}`;
    const finalName = row.type === "market" ? MARKET_LABELS[row.market] || fixedName : fixedName;
    const expectedUrl = `/uploads/asset/${folder}/${encodeURIComponent(expectedFile)}`;

    const oldAbs = path.join(ASSET_ROOT, rel);
    const expectedAbs = path.join(ASSET_ROOT, folder, expectedFile);

    let diskFile = oldAbs;
    if (!fs.existsSync(diskFile)) {
      // 尝试二次 decode（历史数据可能被 encode 两次）
      const rel2 = decodeURIComponent(matchRel(row.url) || "");
      if (rel2 && rel2 !== rel) {
        const alt = path.join(ASSET_ROOT, rel2);
        if (fs.existsSync(alt)) diskFile = alt;
      }
    }
    if (!fs.existsSync(diskFile)) {
      missing++;
      // 文件缺失：仍同步名称（XD/C 前缀、HTML 实体）与规范 URL（无扩展名 / 随机名历史 URL 一并修正，便于后续回填）
      const urlChanged = expectedUrl !== row.url;
      const nameChanged = finalName !== row.name;
      if (urlChanged || nameChanged) {
        if (!DRY) {
          db.prepare("UPDATE assets SET url = ?, name = ?, updated_at = ? WHERE id = ?").run(
            expectedUrl,
            finalName,
            new Date().toISOString(),
            row.id
          );
        }
        problems.push(`[缺失-元数据修正] ${row.id}: ${row.url} → ${expectedUrl}${nameChanged ? ` | name: ${row.name} → ${finalName}` : ""}`);
      } else {
        problems.push(`[文件缺失] ${row.id}: ${rel}`);
      }
      continue;
    }

    const needRename = curFile !== expectedFile || curFolder !== folder;
    const nameChanged = finalName !== row.name;
    const urlChanged = expectedUrl !== row.url;
    if (!needRename && !nameChanged && !urlChanged) continue;

    // 多条记录指向同一期望名 → 冲突，跳过并提示（防止互相覆盖）
    const dupTarget = (expectedCount.get(expectedKey) || 0) > 1;
    if (needRename && dupTarget) {
      conflict++;
      problems.push(`[冲突] ${row.id}: ${path.basename(diskFile)} → ${folder}/${expectedFile}（多条记录指向同一期望名）`);
      continue;
    }

    // 目标已存在且不是自己（大小写差异视为自己）→ 冲突（可能同股票重复下载），跳过并提示
    const selfTarget =
      fs.existsSync(expectedAbs) &&
      path.resolve(expectedAbs).toLowerCase() === path.resolve(diskFile).toLowerCase();
    if (needRename && fs.existsSync(expectedAbs) && !selfTarget) {
      conflict++;
      problems.push(`[冲突] ${row.id}: ${path.basename(diskFile)} → ${folder}/${expectedFile}（目标已存在）`);
      continue;
    }

    const action = [];
    if (needRename) {
      action.push(`${path.relative(ASSET_ROOT, diskFile)} → ${folder}/${expectedFile}`);
      if (!DRY) {
        fs.mkdirSync(path.dirname(expectedAbs), { recursive: true });
        fs.renameSync(diskFile, expectedAbs);
      }
    } else if (urlChanged) {
      action.push(`url: ${row.url} → ${expectedUrl}`);
    }
    if (nameChanged) action.push(`name: ${row.name} → ${finalName}`);

    if (!DRY) {
      db.prepare("UPDATE assets SET url = ?, name = ?, updated_at = ? WHERE id = ?").run(
        expectedUrl,
        finalName,
        new Date().toISOString(),
        row.id
      );
    }
    if (needRename) renamed++;
    if (nameChanged) nameFixed++;
    console.log(`${DRY ? "[DRY]" : "[OK] "} ${row.id}: ${action.join(" | ")}`);
  }

  // 无图标（url 为空）的记录：只做名称修正（XD/C 前缀、HTML 实体）
  const emptyRows = db
    .prepare("SELECT id, type, market, code, name, url FROM assets WHERE url IS NULL OR url = ''")
    .all();
  for (const row of emptyRows) {
    const { fixedName } = expectedRel(row, "png");
    const finalName = row.type === "market" ? MARKET_LABELS[row.market] || fixedName : fixedName;
    if (finalName !== row.name) {
      if (!DRY) {
        db.prepare("UPDATE assets SET name = ?, updated_at = ? WHERE id = ?").run(
          finalName,
          new Date().toISOString(),
          row.id
        );
      }
      nameFixed++;
      console.log(`${DRY ? "[DRY]" : "[OK] "} ${row.id}: name: ${row.name} → ${finalName}（无图标，仅名称修正）`);
    }
  }

  console.log(`\n汇总: 重命名 ${renamed}，名称解码 ${nameFixed}，缺失 ${missing}，冲突 ${conflict}`);
  if (problems.length) {
    console.log("\n待人工处理：");
    for (const p of problems) console.log("  " + p);
  }
  db.close();
}

function matchRel(url) {
  const m = String(url || "").match(/^\/uploads\/asset\/(.+)$/);
  return m ? m[1] : "";
}

main();
