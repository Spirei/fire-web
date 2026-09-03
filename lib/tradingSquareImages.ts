/** 交易广场配图：只允许本地下载路径，远程抓取限白名单 HTTPS 主机。 */

const LOCAL_POST_IMAGE = /^\/uploads\/trading-square\/(trump|duan)\/[a-f0-9]{16}\.(jpg|png|gif|webp)$/;

export function isLocalPostImageUrl(url: string): boolean {
  return LOCAL_POST_IMAGE.test(url);
}

function isPrivateHostname(host: string): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((value) => value > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (hostname.includes(":")) {
    if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")) return true;
  }
  return false;
}

function isAllowedImageHost(host: string): boolean {
  const hostname = host.toLowerCase();
  if (hostname === "xqimg.imedao.com" || hostname.endsWith(".xqimg.imedao.com")) return true;
  if (hostname === "xueqiu.com" || hostname.endsWith(".xueqiu.com")) return true;
  if (hostname.startsWith("truth-archive.") && hostname.endsWith(".linodeobjects.com")) return true;
  if (hostname.endsWith(".truthsocial.com") && (hostname.includes("static-assets") || hostname.includes("media"))) return true;
  return false;
}

export function isAllowedRemoteImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (!parsed.hostname || isPrivateHostname(parsed.hostname)) return false;
    return isAllowedImageHost(parsed.hostname);
  } catch {
    return false;
  }
}
