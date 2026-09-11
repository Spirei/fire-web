#!/usr/bin/env node
/**
 * 卡面库素材抓取（可重复运行，方便后续更新 / 替换）
 *
 * 来源：GitHub HarukaKinen/Cardentify 的 Cards/ 目录（每个银行一个文件夹，含 data.json 元数据 + 卡面图片）。
 * 落地：public/uploads/cards/<国家地区>/<卡类型>/<银行>/<卡名>.webp + manifest.json（页面直接读这份清单）。
 * 说明：
 *  - 图片统一转 WebP、最长边压到 1000px（原图有单张 17MB 的 PNG，523 张合计 300MB+）；
 *  - 已存在的文件默认跳过（--force 覆盖），所以再跑一次只会补新卡；
 *  - uploads 属于本地运行数据，不进 git（见 .gitignore）。
 *
 * 用法：node scripts/fetch-card-assets.mjs [--force] [--limit 20] [--bank "China Merchants Bank"]
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const REPO = "HarukaKinen/Cardentify";
const BRANCH = "main";
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const OUT_ROOT = path.join(process.cwd(), "public", "uploads", "cards");
const MANIFEST = path.join(OUT_ROOT, "manifest.json");
const UA = "fire-card-library-fetcher";
const IMAGE_EXT = /\.(png|jpe?g|webp|svg)$/i;

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) || 0 : 0;
})();
const ONLY_BANK = (() => {
  const i = args.indexOf("--bank");
  return i >= 0 ? String(args[i + 1] || "") : "";
})();

/** ISO 国家码 → 地区文件夹名（卡面库按这个分组） */
const REGION_LABELS = {
  CN: "中国内地",
  HK: "中国香港",
  MO: "中国澳门",
  TW: "中国台湾",
  US: "美国",
  CA: "加拿大",
  JP: "日本",
  KR: "韩国",
  SG: "新加坡",
  MY: "马来西亚",
  TH: "泰国",
  VN: "越南",
  PH: "菲律宾",
  ID: "印度尼西亚",
  IN: "印度",
  AE: "阿联酋",
  SA: "沙特",
  GB: "英国",
  IE: "爱尔兰",
  DE: "德国",
  FR: "法国",
  CH: "瑞士",
  NL: "荷兰",
  BE: "比利时",
  ES: "西班牙",
  IT: "意大利",
  SE: "瑞典",
  NO: "挪威",
  DK: "丹麦",
  FI: "芬兰",
  AT: "奥地利",
  PT: "葡萄牙",
  PL: "波兰",
  RU: "俄罗斯",
  KZ: "哈萨克斯坦",
  AU: "澳大利亚",
  NZ: "新西兰",
  BR: "巴西",
  MX: "墨西哥",
  AR: "阿根廷",
  ZA: "南非"
};

/** 卡类型（上游 card.type）→ 目录名；没有的类型统一进「其他」 */
const TYPE_LABELS = {
  debit: "借记卡",
  credit: "信用卡",
  prepaid: "预付卡",
  charge: "签账卡",
  atm: "取现卡",
  transit: "交通卡",
  gift: "礼品卡",
  virtual: "虚拟卡"
};
const TYPE_ORDER = ["借记卡", "信用卡", "预付卡", "签账卡", "取现卡", "交通卡", "礼品卡", "虚拟卡", "其他"];

function typeLabelOf(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return TYPE_LABELS[key] || "其他";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, attempt = 0) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 3) throw error;
    await sleep(600 * (attempt + 1));
    return fetchJson(url, attempt + 1);
  }
}

async function fetchBinary(url, attempt = 0) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (attempt >= 3) throw error;
    await sleep(600 * (attempt + 1));
    return fetchBinary(url, attempt + 1);
  }
}

/** 文件名安全化：卡名里可能带 / : * ? 等字符 */
function safeName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "card";
}

async function main() {
  console.log("读取远端目录…");
  const tree = await fetchJson(`${API}/git/trees/${BRANCH}?recursive=1`);
  const blobs = (tree?.tree ?? []).filter((item) => item.type === "blob" && item.path.startsWith("Cards/"));

  /** bankFolder → { images: string[]; hasMeta: boolean } */
  const banks = new Map();
  blobs.forEach((item) => {
    const parts = item.path.split("/");
    if (parts.length < 3) return;
    const folder = parts[1];
    const relative = parts.slice(2).join("/");
    if (!banks.has(folder)) banks.set(folder, { images: [], hasMeta: false });
    const entry = banks.get(folder);
    if (/^data\.json$/i.test(relative)) entry.hasMeta = true;
    else if (IMAGE_EXT.test(relative)) entry.images.push(relative);
  });
  console.log(`远端 ${banks.size} 个银行文件夹，${[...banks.values()].reduce((sum, b) => sum + b.images.length, 0)} 张卡面`);

  const regions = new Map();
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let budget = LIMIT || Infinity;

  for (const [folder, entry] of banks) {
    if (ONLY_BANK && folder !== ONLY_BANK) continue;
    if (budget <= 0) break;

    let meta = null;
    if (entry.hasMeta) {
      try {
        meta = await fetchJson(`${RAW}/Cards/${encodeURIComponent(folder)}/data.json`);
      } catch {
        meta = null;
      }
    }
    const country = String(meta?.bank?.country || "XX").toUpperCase();
    const regionLabel = REGION_LABELS[country] || country;
    const bankName = String(meta?.bank?.native_name || folder).trim();
    const bankEnglish = String(meta?.bank?.english_name || folder).trim();
    const cardMeta = new Map(
      (Array.isArray(meta?.cards) ? meta.cards : []).map((card) => [String(card?.description || "").trim(), card])
    );

    if (!regions.has(regionLabel)) regions.set(regionLabel, new Map());
    /** 银行文件夹 → { name, englishName, country, types: Map<类型, cards[]> } */
    const bankEntry = { name: bankName, englishName: bankEnglish, country, types: new Map() };
    regions.get(regionLabel).set(folder, bankEntry);

    for (const relative of entry.images) {
      if (budget <= 0) break;
      const base = relative.replace(IMAGE_EXT, "");
      const cardName = base.trim();
      const meta4 = cardMeta.get(cardName);
      const typeLabel = typeLabelOf(meta4?.card?.type);
      const relativeFile = `${safeName(typeLabel)}/${safeName(bankName)}/${safeName(cardName)}.webp`;
      const target = path.join(OUT_ROOT, safeName(regionLabel), relativeFile);
      const record = {
        name: cardName,
        type: typeLabel,
        file: path.posix.join(
          ...[safeName(regionLabel), safeName(typeLabel), safeName(bankName), `${safeName(cardName)}.webp`].map(encodeURIComponent)
        ),
        sourceType: String(meta4?.card?.type || "").trim(),
        brand: String(meta4?.card?.brand || "").trim(),
        level: String(meta4?.card?.level || "").trim(),
        bins: Array.isArray(meta4?.bin) ? meta4.bin.slice(0, 4) : []
      };
      const list = bankEntry.types.get(typeLabel) ?? [];
      list.push(record);
      bankEntry.types.set(typeLabel, list);

      if (!FORCE && fs.existsSync(target)) {
        skipped += 1;
        budget -= 1;
        continue;
      }
      try {
        const source = `${RAW}/${["Cards", folder, relative].map(encodeURIComponent).join("/")}`;
        const buffer = await fetchBinary(source);
        const converted = await sharp(buffer, { density: 144 })
          .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, converted);
        downloaded += 1;
        budget -= 1;
        if (downloaded % 25 === 0) console.log(`  已下载 ${downloaded} 张（跳过 ${skipped}，失败 ${failed}）`);
      } catch (error) {
        failed += 1;
        budget -= 1;
        console.warn(`  失败：${folder}/${relative} → ${error.message}`);
      }
    }
  }

  // 合并已有 manifest（重复运行时保留此前已抓的银行）
  let previous = { regions: [] };
  try {
    previous = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    previous = { regions: [] };
  }
  const merged = new Map(
    (Array.isArray(previous?.regions) ? previous.regions : []).map((region) => [region.label, region])
  );
  regions.forEach((bankMap, label) => {
    const existing = merged.get(label)?.banks ?? [];
    const byFolder = new Map(existing.map((bank) => [bank.folder, bank]));
    bankMap.forEach((bank, folder) => {
      const previousBank = byFolder.get(folder);
      const mergedCards = new Map((previousBank?.cards ?? []).map((card) => [card.file, card]));
      [...bank.types.values()].flat().forEach((card) => mergedCards.set(card.file, card));
      byFolder.set(folder, {
        name: bank.name,
        englishName: bank.englishName,
        country: bank.country,
        folder,
        cards: [...mergedCards.values()]
      });
    });
    merged.set(label, { label, banks: [...byFolder.values()] });
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: `https://github.com/${REPO}/tree/${BRANCH}/Cards`,
    typeOrder: TYPE_ORDER,
    regions: [...merged.values()]
      .map((region) => ({
        ...region,
        banks: region.banks
          .map((bank) => ({ ...bank, cards: bank.cards.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")) }))
          .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      }))
      .sort((a, b) => b.banks.length - a.banks.length)
  };
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const total = manifest.regions.reduce((sum, region) => sum + region.banks.reduce((n, bank) => n + bank.cards.length, 0), 0);
  console.log(`完成：本次下载 ${downloaded}，跳过 ${skipped}，失败 ${failed}；清单共 ${manifest.regions.length} 个地区 / ${total} 张卡`);
  console.log(`清单：${path.relative(process.cwd(), MANIFEST)}`);
}

main().catch((error) => {
  console.error("抓取失败：", error);
  process.exit(1);
});
