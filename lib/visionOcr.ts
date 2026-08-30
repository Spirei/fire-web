/* Apple Vision (macOS 本地 OCR) —— 编译并调用 Swift 识别工具 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface VisionLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), path.resolve(here, ".."), path.resolve(here, "../..")];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "scripts", "vision-ocr.swift"))) return dir;
  }
  return process.cwd();
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} 执行超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${cmd} 退出码 ${code}`));
    });
  });
}

async function macosSdkPath(): Promise<string> {
  try {
    const { stdout } = await run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], 15_000);
    const sdk = stdout.trim();
    if (sdk) return sdk;
  } catch {
    /* 继续尝试命令行工具默认路径 */
  }
  const fallback = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
  try {
    await fs.access(fallback);
    return fallback;
  } catch {
    throw new Error("未检测到 Apple Vision 运行环境（需要 macOS + Xcode 或 Command Line Tools）");
  }
}

async function ensureBinary(binPath: string, srcPath: string): Promise<void> {
  const [binStat, srcStat] = await Promise.all([
    fs.stat(binPath).catch(() => null),
    fs.stat(srcPath)
  ]);
  if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return;

  await fs.mkdir(path.dirname(binPath), { recursive: true });
  const sdk = await macosSdkPath();
  // 模块缓存放系统临时目录（由系统管理），避免在仓库 .cache 里堆出数百 MB
  const moduleCache = path.join(os.tmpdir(), "fire-swift-module-cache");
  await fs.mkdir(moduleCache, { recursive: true });
  await run(
    "swiftc",
    ["-O", "-sdk", sdk, "-module-cache-path", moduleCache, srcPath, "-o", binPath],
    180_000
  );
}

/** 本地 Apple Vision 识别图片，返回按文本行排列的识别结果（Vision 归一化坐标，原点左下） */
export async function recognizeImage(imagePath: string): Promise<VisionLine[]> {
  const root = projectRoot();
  const binPath = path.join(root, ".cache", `vision-ocr-${process.arch}`);
  const srcPath = path.join(root, "scripts", "vision-ocr.swift");
  await ensureBinary(binPath, srcPath);

  const { stdout } = await run(binPath, [imagePath], 30_000);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is VisionLine =>
          !!item && typeof item.text === "string" && typeof item.x === "number"
      )
      .map((item) => ({
        text: item.text,
        x: item.x,
        y: typeof item.y === "number" ? item.y : 0,
        w: typeof item.w === "number" ? item.w : 0,
        h: typeof item.h === "number" ? item.h : 0
      }));
  } catch {
    return [];
  }
}
