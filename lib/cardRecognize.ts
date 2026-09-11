/**
 * 卡面识别：把「新增卡片」上传的卡面照片交给 DeepSeek 视觉模型，读出发卡行 / 卡名 / 地区 /
 * 类型 / 卡组织 / 等级，自动填进表单（用户仍可改）。未配置 DEEPSEEK_API_KEY 时返回 null，
 * 前端就退回纯手工填写，不影响原来的流程。
 */
import { REGION_CURRENCY } from "./cardCurrencies";
import { askDeepSeekVision } from "./deepseekVision";
import { promises as fs } from "node:fs";
import sharp from "sharp";

export interface RecognizedCard {
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
}

const CARD_TYPES = ["借记卡", "信用卡", "预付卡", "签账卡", "取现卡", "交通卡", "礼品卡", "虚拟卡", "其他"];
const BRAND_ALIASES: { match: RegExp; label: string }[] = [
  { match: /银联|union\s*pay/i, label: "银联" },
  { match: /visa/i, label: "Visa" },
  { match: /master\s*card|万事达/i, label: "Mastercard" },
  { match: /运通|amex|american\s*express/i, label: "美国运通" },
  { match: /jcb/i, label: "JCB" },
  { match: /大来|diners/i, label: "大来" },
  { match: /发现|discover/i, label: "发现" },
  { match: /\bmir\b/i, label: "Mir" }
];

const PROMPT = `你是银行卡识别引擎。看这张银行卡正面照片，只输出一行 JSON（不要代码块、不要解释、不要多余文字）：
{"name":"","bank":"","region":"","type":"","brand":"","level":""}

规则：
1. name：卡片名称，取卡面上能看到的卡种 / 卡名（如「长城借记卡」「经典白金卡」「World Elite Mastercard」）；卡面只有品牌和等级时，用「品牌+等级」拼一个（如「银联白金卡」）。
2. bank：发卡银行的中文名，用卡面上的官方写法（如「招商银行」「香港上海滙豐銀行」）；看不出银行就留空。
3. region：只能从这些里选一个：${Object.keys(REGION_CURRENCY).join(" / ")}；只有能确定发卡行所在地时才填（例如卡面写着 Bank of China (Hong Kong) 才算中国香港），只是看到银行 Logo 判断不了国家 / 地区就留空。
4. type：只能从这些里选一个：${CARD_TYPES.join(" / ")}。
5. brand：卡组织，只能从这些里选一个：银联 / Visa / Mastercard / 美国运通 / JCB / 大来 / 发现 / Mir；看不清留空。
6. level：等级，如 普卡 / 金卡 / 白金 / 世界 / 世界精英 / 无限 / 钻石 / Signature / Platinum / World / Infinite；看不清留空。
7. 任何不确定的字段一律留空字符串，绝对不要编造。`;

/** 本地开发常用 DashScope（通义千问视觉）：OpenAI 兼容接口，和 DeepSeek 同一套请求格式 */
function dashscopeConfig() {
  const apiKey = process.env.DASHSCOPE_API_KEY || "";
  if (!apiKey) return null;
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const model = process.env.VISION_MODEL || "qwen-vl-max";
  return { apiKey, baseUrl, model };
}

/**
 * 问一次视觉模型：优先 DeepSeek（线上配置），没配就退回 DashScope（本地开发配置）；
 * 两个都没有则返回 null，前端退回手工填写。
 */
async function askVision(imagePath: string, mime: string, prompt: string): Promise<string | null> {
  if (process.env.DEEPSEEK_API_KEY) return askDeepSeekVision(imagePath, mime, prompt, 800);
  const dash = dashscopeConfig();
  if (!dash) return null;
  const rawBuffer = await fs.readFile(imagePath).catch(() => null);
  if (!rawBuffer || rawBuffer.length === 0) return null;
  // 视觉模型不吃 SVG：先用 sharp 栅格化成 PNG 再送
  const buffer =
    mime === "image/svg+xml" ? await sharp(rawBuffer, { density: 144 }).png().toBuffer().catch(() => null) : rawBuffer;
  if (!buffer || buffer.length === 0) return null;
  const sendMime = mime === "image/svg+xml" ? "image/png" : mime;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${dash.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${dash.apiKey}` },
      body: JSON.stringify({
        model: dash.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${sendMime};base64,${buffer.toString("base64")}` } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 800
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      console.warn("[card-recognize] DashScope HTTP", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (err) {
    console.warn("[card-recognize]", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 卡面图片识别：返回可直接填表的字段（未配置 Key / 识别失败返回 null） */
export async function recognizeCardImage(imagePath: string, mime: string): Promise<RecognizedCard | null> {
  const raw = await askVision(imagePath, mime, PROMPT);
  if (!raw) return null;
  // 模型偶尔会带 ```json 代码块或前后解释，取第一段 { ... }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string, max: number) => String(parsed[key] ?? "").trim().slice(0, max);
  const name = pick("name", 60);
  const bank = pick("bank", 60);
  const brandRaw = pick("brand", 24);
  const level = pick("level", 24);
  const typeRaw = pick("type", 12);
  const regionRaw = pick("region", 24);

  // 枚举兜底：模型偶尔写成英文或近似词，能对上就用，对不上留空
  const type = CARD_TYPES.includes(typeRaw) ? typeRaw : "";
  const brand = BRAND_ALIASES.find((item) => item.match.test(brandRaw))?.label ?? "";
  const region = Object.keys(REGION_CURRENCY).find((label) => regionRaw.includes(label) || label.includes(regionRaw)) ?? "";

  if (!name && !bank && !region && !type && !brand && !level) return null;
  return { name, bank, region, type, brand, level };
}
