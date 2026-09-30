import type { SiteSettings } from "./types";

/** Browser-safe helpers. Diagnostics never send credentials to a typed address. */
export function normalizeAppConnectionOrigin(value: string, development = false): string {
  const raw = value.trim();
  if (!raw || raw.length > 255 || /[\s\\]/.test(raw)) return "";
  try {
    const explicitProtocol = /^https?:\/\//i.test(raw);
    const url = new URL(explicitProtocol ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    if (development && ["localhost", "127.0.0.1"].includes(host) && ["http:", "https:"].includes(url.protocol)) {
      if (!explicitProtocol) url.protocol = "http:";
      return url.origin;
    }
    if (url.protocol !== "https:" || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || /(?:^|\.)(?:localhost|local|lan|internal)$/.test(host)) return "";
    return url.origin;
  } catch { return ""; }
}

export type AppConnectionFields = Pick<SiteSettings, "domain" | "appDisplayName" | "appDisplayIcon">;
export function appConnectionSettingsPatch(draft: AppConnectionFields, baseline: AppConnectionFields, development = false): Partial<AppConnectionFields> {
  const patch: Partial<AppConnectionFields> = {};
  for (const key of ["domain", "appDisplayName", "appDisplayIcon"] as const) {
    if (draft[key].trim() !== baseline[key].trim()) patch[key] = draft[key].trim();
  }
  if (patch.domain) {
    const origin = normalizeAppConnectionOrigin(patch.domain, development);
    if (!origin) throw new Error("请填写公网 HTTPS 域名，可带端口，不含路径或参数；开发环境可使用 localhost。");
    patch.domain = origin;
  }
  if (patch.appDisplayName !== undefined && patch.appDisplayName.length > 80) throw new Error("App 名称最多 80 个字符。");
  return patch;
}

export type ConnectionCheck = { name: string; ok: boolean; message: string };
const CHECKS = [
  { name: "授权协议", path: "/api/v1/auth/config", validate: (body: any) => body?.code === 0 && body.data?.version === 1 && body.data?.client_id === "fire-ios" && body.data?.redirect_uri === "com.fire.app:/oauth/callback" && body.data?.authorization_path === "/app/authorize" && body.data?.token_path === "/api/v1/auth/token" && body.data?.revoke_path === "/api/v1/auth/revoke" && body.data?.code_challenge_methods_supported?.includes("S256"), success: "PKCE 与固定回调正常" },
  { name: "当前账户", path: "/api/v1/auth/me", validate: (body: any) => body?.code === 0 && typeof body.data?.id === "string", success: "Web 与 App 使用同一账号" },
  { name: "设备管理", path: "/api/v1/auth/devices", validate: (body: any) => body?.code === 0 && Array.isArray(body.data?.devices), success: "可读取本人授权设备" }
] as const;

export async function runAppConnectionChecks(signal: AbortSignal, transport: typeof fetch = fetch): Promise<ConnectionCheck[]> {
  return Promise.all(CHECKS.map(async check => {
    try {
      const res = await transport(check.path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { name: check.name, ok: false, message: typeof body?.message === "string" ? body.message : res.status === 401 ? "登录已失效，请重新登录" : `请求失败（HTTP ${res.status}）` };
      return { name: check.name, ok: check.validate(body), message: check.validate(body) ? check.success : "接口返回不符合连接协议" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { name: check.name, ok: false, message: "连接中断、超时或返回了跳转，请重试" };
    }
  }));
}
