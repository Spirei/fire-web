import {DEFAULT_APP_DEVICE_NAME,normalizeAppDeviceName} from "./brand";
export const APP_CLIENT_ID = "fire-ios";
export const APP_REDIRECT_URI = "com.fire.app:/oauth/callback";
export const APP_SCOPE = "portfolio.read portfolio.write";
// Default connections stay unchanged. Editing identity requires explicit new consent.
export const APP_SUPPORTED_SCOPES = [...APP_SCOPE.split(" "), "assets.read", "positions.read", "cash.read", "orders.read", "orders.write", "orders.cancel", "profile.write", "feed.read", "feed.write", "security.read", "security.write", "resources.read", "resources.write"];
export interface AppAuthorization {
  client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string;
  response_type: string; scope: string; state: string; device_name: string;
}
export function parseAppAuthorization(values: Record<string, unknown>): AppAuthorization {
  const value = (key: string) => typeof values[key] === "string" ? values[key] as string : "";
  const scope = value("scope").split(" ").filter(Boolean);
  if (value("client_id") !== APP_CLIENT_ID || value("redirect_uri") !== APP_REDIRECT_URI || value("response_type") !== "code") throw new Error("不支持的 App 或回调地址");
  if (value("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(value("code_challenge"))) throw new Error("无效的授权校验参数");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value("state"))) throw new Error("无效的授权请求");
  if (!scope.includes("portfolio.read") || scope.some(s => !APP_SUPPORTED_SCOPES.includes(s)) || (scope.includes("feed.write") && !scope.includes("feed.read")) || (scope.includes("security.write") && !scope.includes("security.read")) || (scope.includes("resources.write") && !scope.includes("resources.read"))) throw new Error("不支持的授权范围");
  const deviceName = value("device_name").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64);
  return { client_id: APP_CLIENT_ID, redirect_uri: APP_REDIRECT_URI, response_type: "code", code_challenge_method: "S256", code_challenge: value("code_challenge"), scope: [...new Set(scope)].join(" "), state: value("state"), device_name: normalizeAppDeviceName(deviceName) || DEFAULT_APP_DEVICE_NAME };
}
