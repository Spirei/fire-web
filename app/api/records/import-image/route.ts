import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { sniffImageExt } from "@/lib/imageSecurity";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { recognizeImage, type VisionLine } from "@/lib/visionOcr";
import { deepseekVisionEnabled, recognizeImageWithDeepSeek } from "@/lib/deepseekVision";
import { parseSnapshot, rawText } from "@/lib/snapshotParser";
import { buildImportPreview } from "@/lib/importSnapshot";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp"
};

/** DeepSeek 输出的文本行 → 合成视觉行（每行一个 y，字段按列序排 x），复用现有解析器 */
function deepSeekLinesToVisionLines(lines: string[]): VisionLine[] {
  const out: VisionLine[] = [];
  lines.forEach((line, rowIdx) => {
    const cols = line
      .split(line.includes("|") ? "|" : /\s+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length === 0) return;
    const y = 1 - (rowIdx + 1) * 0.04;
    const h = 0.03;
    cols.forEach((text, colIdx) => {
      out.push({ text, x: colIdx * 0.1, y, w: 0.1, h });
    });
  });
  return out;
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 截图识别（DeepSeek 云端 / Apple Vision 本地兜底）：同 IP 10 次/分钟、全局 30 次/分钟
  if (!rateLimit(`import-image:${clientIp(request)}`, 10, 60 * 1000) || !rateLimitGlobal("import-image", 30, 60 * 1000)) {
    return NextResponse.json({ error: "识别过于频繁，请稍后再试" }, { status: 429 });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "请选择要识别的截图" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "图片过大，最大 8MB" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = sniffImageExt(buffer);
  const mime = ext ? MIME_BY_EXT[ext] : undefined;
  if (!ext || !mime) {
    return NextResponse.json({ error: "仅支持 JPG / PNG / GIF / WEBP 截图" }, { status: 400 });
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-ocr-"));
  const imagePath = path.join(tmpDir, `snapshot.${ext}`);
  await fs.writeFile(imagePath, buffer);
  try {
    let provider: "deepseek" | "apple-vision" = "apple-vision";
    let lines: VisionLine[] = [];
    let raw = "";
    if (deepseekVisionEnabled()) {
      const ds = await recognizeImageWithDeepSeek(imagePath, mime);
      if (ds && ds.lines.length > 0) {
        lines = deepSeekLinesToVisionLines(ds.lines);
        raw = ds.raw;
        provider = "deepseek";
      }
    }
    if (provider !== "deepseek") {
      lines = await recognizeImage(imagePath);
      raw = rawText(lines);
    }
    let rows = parseSnapshot(lines);
    let preview = buildImportPreview(user.id, rows);
    // DeepSeek 没解析出股票时回退本地 Apple Vision 再试一次
    if (preview.length === 0 && provider === "deepseek") {
      lines = await recognizeImage(imagePath);
      rows = parseSnapshot(lines);
      preview = buildImportPreview(user.id, rows);
      raw = rawText(lines);
      provider = "apple-vision";
    }
    if (preview.length === 0) {
      return NextResponse.json(
        { error: "没有从截图中识别到股票，请换一张持仓 / 行情列表截图", rows: [], raw },
        { status: 422 }
      );
    }
    return NextResponse.json({ rows: preview, raw, provider });
  } catch (err) {
    const message = err instanceof Error ? err.message : "识别失败";
    if (/Apple Vision|Xcode|Command Line Tools/.test(message)) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return NextResponse.json({ error: `识别失败：${message}` }, { status: 500 });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
