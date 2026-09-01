import { connect } from "node:net";
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

function updaterReachable(url: string) {
  return new Promise<boolean>((resolve) => {
    let target: URL;
    try { target = new URL(url); } catch { resolve(false); return; }
    const socket = connect({ host: target.hostname, port: Number(target.port || (target.protocol === "https:" ? 443 : 80)) });
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(1500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function GET(request: Request) {
  if (!requireAdmin(request)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { url, token } = updaterConfig();
  const configured = token.length >= 32;
  const reachable = configured ? await updaterReachable(url) : false;
  return NextResponse.json({
    available: configured && reachable,
    configured,
    reachable,
    reason: !configured ? "群晖尚未配置 Watchtower Token" : !reachable ? "fire-updater 未启动或不在当前 Compose 网络" : "更新服务在线"
  });
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
      signal: AbortSignal.timeout(30_000)
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
    if (error instanceof Error && error.name === "TimeoutError") {
      return NextResponse.json({
        ok: true,
        pending: true,
        message: "更新请求已接受，fire-updater 仍在后台拉取镜像，正在等待容器恢复"
      }, { status: 202 });
    }
    return NextResponse.json({ error: "无法连接容器更新服务，请确认 fire-updater 已启动" }, { status: 502 });
  }
}
