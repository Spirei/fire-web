import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

const DEFAULT_UPDATER_URL = "http://fire-updater:8080/v1/update";
const TRIGGER_COOLDOWN_MS = 30_000;
let lastTriggerAt = 0;

function updaterConfig() {
  return {
    url: process.env.FIRE_UPDATER_URL?.trim() || DEFAULT_UPDATER_URL,
    token: process.env.WATCHTOWER_HTTP_API_TOKEN?.trim() || ""
  };
}

function requireAdmin(request: Request) {
  const user = getAuthUser(request);
  return Boolean(user && isAdmin(user));
}

export async function GET(request: Request) {
  if (!requireAdmin(request)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { token } = updaterConfig();
  return NextResponse.json({ available: token.length >= 32 });
}

export async function POST(request: Request) {
  if (!requireAdmin(request)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const { url, token } = updaterConfig();
  if (token.length < 32) {
    return NextResponse.json({ error: "未配置 WATCHTOWER_HTTP_API_TOKEN，或长度不足 32 位" }, { status: 503 });
  }
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
    return NextResponse.json({ error: "更新检查刚刚已触发，请 30 秒后再试" }, { status: 429 });
  }
  lastTriggerAt = now;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) {
      lastTriggerAt = 0;
      return NextResponse.json({ error: `容器更新服务返回 ${response.status}` }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      message: "已通知群晖拉取最新镜像；若镜像有更新，Fire 将自动重启"
    });
  } catch (error) {
    lastTriggerAt = 0;
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "容器更新服务响应超时，请检查 fire-updater 日志"
      : "无法连接容器更新服务，请确认 fire-updater 已启动";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
