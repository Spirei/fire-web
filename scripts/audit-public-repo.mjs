#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = [...new Set( execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean))];

const forbiddenText = [
  {
    label: "个人 GitHub / 登录名",
    pattern: new RegExp(`\\b(?:${["Spi", "rei"].join("")}|${["Spi", "re"].join("")})\\b`, "i")
  },
  { label: "本机用户绝对路径", pattern: /\/Users\/[^/\s]+\// },
  { label: "macOS 挂载盘绝对路径", pattern: /\/Volumes\/docker\// },
  { label: "个人代理默认地址", pattern: /127\.0\.0\.1:1082/ },
  { label: "个人 NAS 硬件型号", pattern: new RegExp(`\\b${["J4", "125"].join("")}\\b`, "i") },
  { label: "GitHub classic token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { label: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "疑似 API Key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "私钥", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

const deploymentFiles = new Set([
  "docker-compose.ghcr.yml",
  "Dockerfile",
  ".env.example"
]);

// 四色门侧栏运行必需的 4 个素材：体积极小、缺任意一个侧栏入口会先闪再消失，
// 已获准随公开仓库分发（其余 public/uploads、二进制素材仍然禁止入库）。
const publicMediaAllowlist = new Set([
  // 配色设置入口的内置矢量图标，属于产品源码，不是用户上传或部署私有素材。
  "public/icons/palette.svg",
  "public/uploads/feature/four-door/window.png",
  "public/uploads/feature/four-door/dial.png",
  "public/uploads/feature/four-door/pointer.png",
  "public/uploads/feature/four-door/cursor-hand.png"
]);

const findings = [];
for (const file of tracked) {
  if (!publicMediaAllowlist.has(file)) {
    if (/^public\/(?:uploads\/(?!\.gitkeep$)|fonts\/|images\/|share\/|icons\/|mockups\/)/.test(file)) findings.push(`${file}: 部署素材不得进入公开仓库`);
    if (/\.(?:png|jpe?g|gif|webp|avif|ico|mp3|wav|ogg|woff2?|ttf)$/i.test(file)) findings.push(`${file}: 二进制素材不得进入公开仓库`);
  }
  let buffer;
  try { buffer = readFileSync(file); }
  catch (error) {
    if (error.code === "ENOENT") continue; // Deleted tracked files are absent from this working tree.
    throw error;
  }
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");

  for (const rule of forbiddenText) {
    const match = text.match(rule.pattern);
    if (match) findings.push(`${file}: ${rule.label}（内容已隐藏）`);
  }

  if (deploymentFiles.has(file)) {
    if (/\/volume\d+\//i.test(text)) findings.push(`${file}: 部署配置写死群晖绝对路径`);
    if (/['"]16000:3000['"]/.test(text)) findings.push(`${file}: 部署配置写死个人宿主端口`);
  }

  if (/^public\/uploads\/(?:background|ico|login|logo)\/.*\d{10,}/.test(file)) {
    findings.push(`${file}: 疑似用户上传的时间戳素材被纳入仓库`);
  }
}

if (findings.length > 0) {
  console.error("公开仓库审计失败：\n");
  findings.forEach((item) => console.error(`- ${item}`));
  console.error("\n请改用占位符、环境变量或未跟踪的本地配置后再提交。");
  process.exit(1);
}

console.log(`公开仓库审计通过：已检查 ${tracked.length} 个 Git 跟踪文件。`);
