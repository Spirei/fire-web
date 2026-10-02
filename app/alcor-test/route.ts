import { appPackagesHtml } from "@/lib/appPackagesPage";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { readThemeFromCookieHeader } from "@/lib/theme";
export async function GET(request: Request) {
  if (!isAdmin(getAuthUser(request))) {
    return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>内部安装包中心</title><body style="font:16px system-ui;padding:48px"><h1>内部安装包中心</h1><p>仅管理员可访问，请先登录管理员账号。</p><a href="/">返回首页登录</a></body></html>', { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
  }
  const dark = readThemeFromCookieHeader(request.headers.get("cookie") || "") === "dark";
  return new Response(appPackagesHtml.replace('<html lang="zh-CN">', `<html lang="zh-CN" class="${dark ? "dark" : ""}">`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
