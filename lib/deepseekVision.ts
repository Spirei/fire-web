/* DeepSeek 视觉识别（deepseek-v4-flash-vision-exp）—— 云端 OCR。
 * 配置 DEEPSEEK_API_KEY 后截图导入优先走 DeepSeek；未配置或调用失败时由
 * 上层回退本地 Apple Vision，不影响原有链路。
 */
import { promises as fs } from "node:fs";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash-vision-exp";

export interface DeepSeekVisionResult {
  /** 模型输出的文本行（一行一只股票） */
  lines: string[];
  /** 完整原始输出 */
  raw: string;
  provider: "deepseek";
}

export function deepseekVisionEnabled(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

function config() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.DEEPSEEK_VISION_MODEL || DEFAULT_MODEL
  };
}

const USER_PROMPT = `你是股票持仓 / 行情截图 OCR 引擎。请识别图中每一行股票，严格按以下格式输出，一行一只股票，字段之间用半角竖线 | 分隔，不要输出表头、序号、解释、代码块标记或任何多余文字：

名称|代码|数量|成本|现价|涨跌幅

规则：
1. 代码尽量保留市场后缀（美股 AAPL、港股 0700.HK、A股 600519.SH），截图上没有后缀就写纯代码。
2. 数量、成本、现价只写数字，不要货币符号、千分位逗号；成本 / 现价保留小数（如 84.34）。
3. 涨跌幅写数字加百分号（如 +5.67% 或 -2.1%）。
4. 如果截图是行情列表（没有数量 / 成本），对应字段留空，例如：英伟达|NVDA|||138.2|+3.1%。
5. 只输出截图里确实出现的股票行；标题、表头、页脚、菜单、时间、账户信息等一律忽略。`;

/**
 * 调用 DeepSeek 视觉模型识别截图，返回结构化文本行。
 * 未配置 Key / 图片为空 / 调用失败均返回 null（不抛错，交给上层回退）。
 */
export async function askDeepSeekVision(
  imagePath: string,
  mime: string,
  prompt: string,
  maxTokens = 4000
): Promise<string | null> {
  if (!deepseekVisionEnabled()) return null;
  const buffer = await fs.readFile(imagePath).catch(() => null);
  if (!buffer || buffer.length === 0) return null;

  const { apiKey, baseUrl, model } = config();
  const b64 = buffer.toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return null;
    return content.trim();
  } catch (err) {
    console.warn("[deepseek-vision]", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 DeepSeek 视觉模型识别截图，返回结构化文本行。
 * 未配置 Key / 图片为空 / 调用失败均返回 null（不抛错，交给上层回退）。
 */
export async function recognizeImageWithDeepSeek(
  imagePath: string,
  mime: string
): Promise<DeepSeekVisionResult | null> {
  const raw = await askDeepSeekVision(imagePath, mime, USER_PROMPT);
  if (!raw) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return { lines, raw, provider: "deepseek" };
}
