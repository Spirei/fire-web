/** Shared browser/server validation: only the configured origin can use this deployment's passkeys. */
export type PasskeyConfigFields = { enabled: boolean; origin: string; name: string };
export type PublicPasskeyConfig = PasskeyConfigFields & { revision: string };

export function parsePasskeyConfig(value: { enabled?: unknown; origin?: unknown; name?: unknown }): PasskeyConfigFields {
  if (typeof value.enabled !== "boolean") throw new Error("请选择是否启用通行密钥");
  const name = String(value.name ?? "Fire").trim();
  if (!name || name.length > 64) throw new Error("站点名称需为 1–64 个字符");
  const raw = String(value.origin ?? "").trim();
  let origin = "";
  if (raw) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("请填写完整 HTTPS 地址，如 https://fire.example.com"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.includes(":") || !url.hostname || url.hostname.endsWith(".")) {
      throw new Error("请填写 HTTPS 域名，不含路径、参数或 IP；本地测试可用 http://localhost:3000");
    }
    origin = url.origin;
  }
  if (value.enabled && !origin) throw new Error("启用前请填写 HTTPS 地址");
  return { enabled: value.enabled, origin, name };
}

export function isPublicPasskeyConfig(value: unknown): value is PublicPasskeyConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PublicPasskeyConfig>;
  if (typeof item.enabled !== "boolean" || typeof item.origin !== "string" || typeof item.name !== "string" || typeof item.revision !== "string") return false;
  try {
    const parsed = parsePasskeyConfig(item);
    return parsed.origin === item.origin && parsed.name === item.name;
  } catch { return false; }
}
