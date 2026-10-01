import type { SiteSettings } from "./types";
import { readLimitedResponseJson } from "./requestBody";

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
export type AppDevice = { id: string; name: string; scope: string; createdAt: number; lastUsedAt: number };
export function parseAppDevices(value: unknown): AppDevice[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
  const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
  return value.every(device => device && text(device.id, 128) && text(device.name, 64) && text(device.scope, 256) && timestamp(device.createdAt) && timestamp(device.lastUsedAt)) && new Set(value.map(device => device.id)).size === value.length ? value : null;
}
/** Accept only the fixed native callback and the state bound to this consent page. */
export function validAppAuthorizationCallback(value: unknown, state: string, decision: "allow" | "deny"): value is string {
  if (typeof value !== "string" || value.length > 1024 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (`${url.protocol}${url.pathname}` !== "com.fire.app:/oauth/callback" || url.host || url.hash || url.username || url.password || url.searchParams.get("state") !== state) return false;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || new Set(keys).size !== 2) return false;
    return decision === "allow" ? /^fac_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code") || "") && !url.searchParams.has("error") : url.searchParams.get("error") === "access_denied" && !url.searchParams.has("code");
  } catch { return false; }
}
const CHECKS = [
  { name: "授权协议", path: "/api/v1/auth/config", validate: (body: any) => body?.code === 0 && body.data?.version === 1 && body.data?.client_id === "fire-ios" && body.data?.redirect_uri === "com.fire.app:/oauth/callback" && body.data?.authorization_path === "/app/authorize" && body.data?.token_path === "/api/v1/auth/token" && body.data?.revoke_path === "/api/v1/auth/revoke" && Array.isArray(body.data?.code_challenge_methods_supported) && body.data.code_challenge_methods_supported.includes("S256"), success: "PKCE 与固定回调正常" },
  { name: "当前账户", path: "/api/v1/auth/me", validate: (body: any) => body?.code === 0 && typeof body.data?.id === "string" && body.data.id.length > 0, success: "Web 与 App 使用同一账号" },
  { name: "设备管理", path: "/api/v1/auth/devices", validate: (body: any) => body?.code === 0 && parseAppDevices(body.data?.devices) !== null, success: "可读取本人授权设备" }
] as const;

export async function runAppConnectionChecks(signal: AbortSignal, transport: typeof fetch = fetch): Promise<ConnectionCheck[]> {
  return Promise.all(CHECKS.map(async check => {
    try {
      const res = await transport(check.path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
      const body = await readLimitedResponseJson(res, 64 * 1024);
      if (!res.ok) return { name: check.name, ok: false, message: res.status === 401 ? "登录已失效，请重新登录" : `请求失败（HTTP ${res.status}）` };
      const valid = check.validate(body);
      return { name: check.name, ok: valid, message: valid ? check.success : "接口返回不符合连接协议" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { name: check.name, ok: false, message: "连接中断、超时或返回了跳转，请重试" };
    }
  }));
}
