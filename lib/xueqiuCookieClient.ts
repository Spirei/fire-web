"use client";

import { readLimitedResponseJson } from "@/lib/requestBody";

/** Only called by an explicit reveal/copy action; never by settings loading. */
export async function readXueqiuCookie(signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/settings/xueqiu-cookie", {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json" }, signal
  });
  if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : response.status === 403 ? "需要管理员权限" : response.status === 404 ? "未找到可读取的 Cookie，请重新配置" : response.status === 429 ? "操作频繁，请稍后重试" : "Cookie 读取失败，请重试");
  const data = await readLimitedResponseJson<{ cookie?: unknown }>(response, 32 * 1024);
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
  if (!data || typeof data.cookie !== "string" || !data.cookie || data.cookie.length > 16384) throw new Error("未找到可读取的 Cookie，请重新配置");
  return data.cookie;
}

export type XueqiuCookieDraft = { value: string; dirty: boolean };

/** A blank untouched field preserves the credential; deleting an edited value clears it on Save. */
export function xueqiuCookiePatch(draft: XueqiuCookieDraft): { xueqiuCookie?: string; clearXueqiuCookie?: boolean } {
  if (!draft.dirty) return {};
  const value = draft.value.trim();
  return value ? { xueqiuCookie: value } : { clearXueqiuCookie: true };
}
