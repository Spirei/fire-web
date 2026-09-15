import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * macOS 本机剪贴板写入（PNG）
 *
 * 用途：局域网 http（非安全上下文）下浏览器 navigator.clipboard 不可用，
 * 由服务端用 osascript 把图片写入 Mac 系统剪贴板，聊天窗口（微信等）可直接粘贴分享。
 * 安全：仅登录用户、限流、PNG 魔数校验、≤8MB、临时文件名由服务端生成（无注入面）。
 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`clipboard:${clientIp(request)}`, 10, 60 * 1000) || !rateLimitGlobal("clipboard", 30, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  const raw = typeof body?.image === "string" ? body.image : "";
  const b64 = raw.startsWith("data:image/png;base64,") ? raw.slice("data:image/png;base64,".length) : raw;
  if (!b64) return NextResponse.json({ error: "缺少图片数据" }, { status: 400 });
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0 || buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "图片过大，最大 8MB" }, { status: 400 });
  }
  // PNG 魔数嗅探
  if (buffer.length < 8 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    return NextResponse.json({ error: "仅支持 PNG 图片" }, { status: 400 });
  }

  const tmpFile = path.join(os.tmpdir(), `fire-clipboard-${crypto.randomUUID()}.png`);
  try {
    await fs.writeFile(tmpFile, buffer);
    const escaped = tmpFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)\nreturn "ok"`;
    await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "写入剪贴板失败";
    return NextResponse.json({ error: `复制失败：${message}` }, { status: 500 });
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
  }
}
