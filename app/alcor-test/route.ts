import { appPackagesHtml } from "@/lib/appPackagesPage";
import { readThemeFromCookieHeader } from "@/lib/theme";
export async function GET(request: Request) {
  const dark = readThemeFromCookieHeader(request.headers.get("cookie") || "") === "dark";
  return new Response(appPackagesHtml.replace('<html lang="zh-CN">', `<html lang="zh-CN" class="${dark ? "dark" : ""}">`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
