#!/usr/bin/env node
/**
 * 生成卡面库的中英对照表：data/card-names-en.json
 *
 * 素材里卡名中英混杂 —— 中文卡名（中银长城借记卡）和英文卡名（Chase Debit Card）都有，
 * 银行名也有一半是纯英文（Chase / DBS Bank），所以这张表是双向的：
 *   cards    中文卡名 → 英文名（卡面库切「英文」时用）
 *   cardsZh  英文卡名 → 中文名（切「原文 / 简体 / 繁體」时用）
 *   banksZh  英文银行名 → 中文名
 * 结果落成静态文件，前端直接查表：不联网、不花钱。
 *
 * 断点续跑：已经有的条目直接跳过，素材库新增卡片后重跑一次只补新的那几张。
 * 用法：node scripts/gen-card-en.mjs           （补齐缺失项）
 *      node scripts/gen-card-en.mjs --force   （全部重翻）
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "public/uploads/cards/manifest.json");
const OUT = path.join(ROOT, "data/card-names-en.json");
/** 每批数量：太多会被接口判超时，10 个一批最稳（失败会按批重试 3 次，仍失败就留到下轮） */
const BATCH = 10;
const FORCE = process.argv.includes("--force");

/** 脚本在 Next 之外运行，不会自动读 .env；这里手工加载（不覆盖已有的环境变量） */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const matched = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!matched) continue;
    const value = matched[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[matched[1]] && value) process.env[matched[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));
loadEnvFile(path.join(ROOT, ".env"));

/** 和站内识别一样：有 DeepSeek 就用 DeepSeek（线上），否则退回 DashScope 兼容接口（本地开发） */
function providerConfig() {
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "").trim();
  if (deepseekKey) {
    return {
      name: "DeepSeek",
      apiKey: deepseekKey,
      baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat"
    };
  }
  const dashKey = (process.env.DASHSCOPE_API_KEY || "").trim();
  if (dashKey) {
    return {
      name: "DashScope",
      apiKey: dashKey,
      baseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
      model: process.env.TEXT_MODEL || process.env.DASHSCOPE_TEXT_MODEL || process.env.VISION_MODEL || "qwen-plus"
    };
  }
  return null;
}

const provider = providerConfig();
if (!provider) {
  console.error("缺少大模型密钥：在 .env.local 里配 DEEPSEEK_API_KEY 或 DASHSCOPE_API_KEY");
  process.exit(1);
}

const SYSTEM_CARD_EN = [
  "你是银行卡名称本地化专家。用户给一批中文银行卡名称（可能含港台繁体、英文单词或符号），",
  "请给出每张卡在海外最常用的英文全称：",
  "1) 优先用该卡真实的官方英文名，例如「中银长城借记卡」= BOC Great Wall Debit Card；",
  "2) 没有公认英文名时，按「银行/品牌 + 卡种 + 特色」的通行写法翻译，不要逐字硬翻；",
  "3) 原名里本来就有的英文（Hello Kitty、VISA、Disney 等）原样保留，不要音译；",
  "4) 保持简短，像卡片正面印的那种名字。",
  "只输出 JSON 对象：键是原来的中文名，值是英文名。不要解释、不要 markdown 代码块。"
].join("");

const SYSTEM_CARD_ZH = [
  "你是银行卡名称本地化专家。用户给一批英文银行卡名称，请给出它们在中国大陆通行的中文叫法：",
  "1) 用国内媒体和银行官网的常见写法，例如 Chase Freedom Flex = 大通银行 Freedom Flex 信用卡，",
  "   Apple Card = 苹果卡，HSBC UK - Global Money = 汇丰英国 Global Money 账户卡，Blue Cash Everyday = 美国运通 Blue Cash Everyday 信用卡；",
  "2) 卡组织 / 品牌名（Visa、Mastercard、Amex、JCB、UnionPay）保留英文，不要翻成「维萨」「万事达」以外的生硬音译；",
  "3) 人名、地名、联名品牌（Costco、Hilton、Disney）保留英文；",
  "4) 数字与型号（S、2233、V）原样保留。",
  "只输出 JSON 对象：键是英文原名，值是中文名。不要解释、不要 markdown 代码块。"
].join("");

const SYSTEM_BANK_ZH = [
  "你是银行名称本地化专家。用户给一批英文银行名，请给出它们在中国大陆通行的中文名：",
  "例如 Chase = 大通银行，DBS Bank = 星展银行，American Express = 美国运通，",
  "HSBC Bank (USA) = 汇丰银行（美国），Commonwealth Bank of Australia = 澳大利亚联邦银行，",
  "Maybank SG = 马来亚银行（新加坡），Bank of America = 美国银行。",
  "没有公认中文名的（Chime、KOHO、MariBank、DasherDirect 这类）原样保留英文，不要硬造。",
  "只输出 JSON 对象：键是英文原名，值是中文名。不要解释、不要 markdown 代码块。"
].join("");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const manifest = readJson(MANIFEST, null);
if (!manifest?.regions) {
  console.error(`读不到卡面清单：${MANIFEST}`);
  process.exit(1);
}

const cardNames = new Set();
const bankNames = new Set();
for (const region of manifest.regions) {
  for (const bank of region.banks ?? []) {
    if (bank.name) bankNames.add(bank.name.trim());
    for (const card of bank.cards ?? []) if (card.name) cardNames.add(card.name.trim());
  }
}
const allCards = [...cardNames].sort();
const allBanks = [...bankNames].sort();
const HAN = /[\u3400-\u9fff]/;

const store = readJson(OUT, { generatedAt: "", model: "", cards: {}, cardsZh: {}, banksZh: {} });
for (const key of ["cards", "cardsZh", "banksZh"]) {
  store[key] = store[key] && typeof store[key] === "object" ? store[key] : {};
}

async function translateBatch(batch, system) {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(batch) }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?|```$/g, "");
  const parsed = JSON.parse(text);
  const out = {};
  for (const name of batch) {
    const value = parsed[name];
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  }
  return out;
}

/** 跑一轮：把 todo 里的名字按批翻好，写进 store[key]，每批都落盘（可随时中断） */
async function runPass({ label, key, todo, system }) {
  if (todo.length === 0) {
    console.log(`${label}：无需补充`);
    return;
  }
  console.log(`${label}：待翻 ${todo.length} 个`);
  for (let index = 0; index < todo.length; index += BATCH) {
    const batch = todo.slice(index, index + BATCH);
    let added = {};
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        added = await translateBatch(batch, system);
        break;
      } catch (error) {
        console.warn(`  第 ${index / BATCH + 1} 批第 ${attempt} 次失败：${error.message}`);
        added = {};
      }
    }
    Object.assign(store[key], added);
    store.generatedAt = new Date().toISOString();
    store.model = provider.model;
    store.source = `${provider.name}（脚本一次性生成，前端静态读取）`;
    fs.writeFileSync(OUT, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`  第 ${Math.min(index + BATCH, todo.length)}/${todo.length} 个，本批成功 ${Object.keys(added).length}`);
  }
}

await runPass({
  label: "中文卡名 → 英文",
  key: "cards",
  todo: allCards.filter((name) => FORCE || !store.cards[name]),
  system: SYSTEM_CARD_EN
});

await runPass({
  label: "英文卡名 → 中文",
  key: "cardsZh",
  todo: allCards.filter((name) => !HAN.test(name) && (FORCE || !store.cardsZh[name])),
  system: SYSTEM_CARD_ZH
});

await runPass({
  label: "英文银行名 → 中文",
  key: "banksZh",
  todo: allBanks.filter((name) => !HAN.test(name) && (FORCE || !store.banksZh[name])),
  system: SYSTEM_BANK_ZH
});

const missingCards = allCards.filter((name) => !store.cards[name]);
const missingZh = allCards.filter((name) => !HAN.test(name) && !store.cardsZh[name]);
const missingBanks = allBanks.filter((name) => !HAN.test(name) && !store.banksZh[name]);
console.log(`完成：${OUT}`);
console.log(
  `卡名英文 ${allCards.length - missingCards.length}/${allCards.length}｜英文卡名中文 ${allCards.length - missingZh.length - allCards.filter((n) => HAN.test(n)).length}/${allCards.filter((n) => !HAN.test(n)).length}｜英文行名中文 ${allBanks.length - missingBanks.length - allBanks.filter((n) => HAN.test(n)).length}/${allBanks.filter((n) => !HAN.test(n)).length}`
);
if (missingCards.length || missingZh.length || missingBanks.length) {
  console.log("仍有缺项（重跑脚本补齐）：", { missingCards: missingCards.length, missingZh: missingZh.length, missingBanks: missingBanks.length });
}
