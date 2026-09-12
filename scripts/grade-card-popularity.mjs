#!/usr/bin/env node
/**
 * 给卡面库打「全网讨论热度」分（0-10）。
 *
 * 为什么不用爬虫：小红书 / 飞客茶馆 / 微博 / 知乎 都没有公开的「按卡查询讨论量」接口，
 * 搜索引擎的结果数也早没有稳定可用的公开 API，硬爬既脆弱又容易踩 ToS。
 * 所以这里换一条稳的路：把清单里的卡（银行 + 卡名 + 类型 + 地区）分批交给大模型，
 * 用它的行业常识给热度分 + 一句依据，产物固化到 lib/cardPopularity.ts，
 * 线上只读这份静态数据 —— 不调 API、不联网、可复现。
 *
 * 用法：
 *   node scripts/grade-card-popularity.mjs            # 增量：只补没打过分的新卡
 *   node scripts/grade-card-popularity.mjs --force    # 全部重打
 *   node scripts/grade-card-popularity.mjs --limit 40 # 只处理前 40 张（试跑）
 *
 * 供应商：优先 DEEPSEEK_API_KEY（deepseek-chat），否则 DASHSCOPE_API_KEY（默认 qwen-plus）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "public/uploads/cards/manifest.json");
const OUT = path.join(ROOT, "lib/cardPopularity.ts");
const BATCH = 20;

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) || 0 : 0;
})();

/** 读 .env.local（Next 会自动加载，普通 node 脚本要自己读） */
function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((line) => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) return;
        const value = m[2].replace(/^["']|["']$/g, "");
        if (value && !process.env[m[1]]) process.env[m[1]] = value;
      });
    } catch {
      /* 没有就算了 */
    }
  }
}

function provider() {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      name: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
      model: process.env.DEEPSEEK_TEXT_MODEL || "deepseek-chat"
    };
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return {
      name: "dashscope",
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
      model: process.env.LLM_MODEL || "qwen-plus"
    };
  }
  return null;
}

const PROMPT_HEAD = `你是银行卡 / 信用卡行业分析师。给下面每张卡打一个「全网讨论热度」分（0-10 的整数）：
10 = 顶流（长期被反复讨论，例如招商银行经典白金卡、浦发 AE 白金卡）
7-9 = 知名主力卡、有口碑
4-6 = 普通卡，偶尔被提到
1-3 = 冷门卡、区域性卡、基本没人讨论的联名卡
判断依据综合：发卡行、卡等级、卡组织、卡种、是否网红联名 / 热门权益。
只输出 JSON 数组，不要任何解释或代码块标记：
[{"i":1,"score":8,"why":"经典高端卡"}]
i 是列表序号，why 不超过 10 个字。

列表：`;

async function askBatch(cfg, cards, offset) {
  const lines = cards.map((card, index) => `${offset + index + 1}. ${card.region}｜${card.bank}｜${card.name}｜${card.type}`).join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: `${PROMPT_HEAD}\n${lines}` }],
        temperature: 0.2,
        max_tokens: 2000
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const match = String(content).match(/\[[\s\S]*\]/);
    if (!match) throw new Error("模型没有返回 JSON 数组");
    const parsed = JSON.parse(match[0]);
    return parsed
      .map((item) => ({
        index: Number(item?.i) - offset - 1,
        score: Math.max(0, Math.min(10, Math.round(Number(item?.score)))),
        why: String(item?.why ?? "").slice(0, 16)
      }))
      .filter((item) => Number.isFinite(item.score) && item.index >= 0 && item.index < cards.length);
  } finally {
    clearTimeout(timer);
  }
}

function readExisting() {
  try {
    const src = fs.readFileSync(OUT, "utf8");
    const json = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
    return JSON.parse(json.replace(/(\w+):/g, '"$1":').replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]"));
  } catch {
    return {};
  }
}

function writeOut(map) {
  const keys = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const body = keys.map((key) => `  ${JSON.stringify(key)}: { score: ${map[key].score}, why: ${JSON.stringify(map[key].why)} }`).join(",\n");
  const src = `/**
 * 卡面库「全网讨论热度」（0-10）——由 scripts/grade-card-popularity.mjs 调用大模型批量生成，
 * 依据是模型对银行卡 / 信用卡行业的常识（不是实时爬虫数据；社区平台没有公开的按卡讨论量接口）。
 * 想更新：\`node scripts/grade-card-popularity.mjs\`（增量）或加 --force 全部重打。
 * key 是清单里的 card file，与 holdings / amounts / 标签用的 key 一致。
 */
export interface CardPopularity {
  score: number;
  why: string;
}

export const CARD_POPULARITY: Record<string, CardPopularity> = {
${body}
};
`;
  fs.writeFileSync(OUT, src);
}

async function main() {
  loadEnv();
  const cfg = provider();
  if (!cfg) {
    console.error("没有可用的模型 Key：请在 .env.local 配置 DEEPSEEK_API_KEY 或 DASHSCOPE_API_KEY");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const all = [];
  manifest.regions.forEach((region) => {
    region.banks.forEach((bank) => {
      bank.cards.forEach((card) => {
        all.push({ file: card.file, name: card.name, type: card.type || "其他", bank: bank.name, region: region.label });
      });
    });
  });
  const existing = FORCE ? {} : readExisting();
  const pending = all.filter((card) => !existing[card.file]);
  const target = LIMIT ? pending.slice(0, LIMIT) : pending;
  console.log(`模型：${cfg.name} / ${cfg.model}｜清单 ${all.length} 张，已打分 ${Object.keys(existing).length} 张，本次处理 ${target.length} 张`);
  if (target.length === 0) {
    writeOut(existing);
    console.log("没有需要打分的卡，已重写输出文件");
    return;
  }
  const map = { ...existing };
  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    let scored = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        scored = await askBatch(cfg, batch, i);
        break;
      } catch (err) {
        console.warn(`  第 ${i + 1}-${i + batch.length} 张第 ${attempt} 次失败：${err instanceof Error ? err.message : err}`);
      }
    }
    scored.forEach((item) => {
      const card = batch[item.index];
      if (card) map[card.file] = { score: item.score, why: item.why };
    });
    console.log(`  已处理 ${Math.min(i + BATCH, target.length)}/${target.length}`);
    writeOut(map);
  }
  console.log(`完成：共 ${Object.keys(map).length} 张有热度分 → ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
