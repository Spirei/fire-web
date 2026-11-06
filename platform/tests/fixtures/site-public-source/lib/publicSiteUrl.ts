import { publicVerificationOrigin } from "./emailVerification";

/** Only publish a configured HTTPS domain; never echo a LAN address or request Host. */
export function publicSiteDomain(domain: string): string {
  return publicVerificationOrigin(domain);
}

/** GitHub redirects must stay on the same public origin that started the flow. */
export function githubOAuthCallbackUrl(request: Request, configured: string, domain: string, emailLinkOrigin: string): string {
  const requestOrigin = publicVerificationOrigin(new URL(request.url).origin);
  if (!requestOrigin) throw new Error("请通过公网 HTTPS 地址访问部署状态页，再连接 GitHub");

  const raw = configured.trim();
  let callback: URL;
  if (raw) {
    try { callback = new URL(raw); }
    catch { throw new Error("GITHUB_OAUTH_CALLBACK_URL 必须是完整的公网 HTTPS 回调地址"); }
    if (publicVerificationOrigin(callback.origin) !== callback.origin || callback.pathname !== "/api/deploy-status/github/callback" || callback.search || callback.hash || callback.username || callback.password) {
      throw new Error("GITHUB_OAUTH_CALLBACK_URL 必须是当前站点的公网 HTTPS 回调地址，且不带参数");
    }
  } else {
    const origin = publicSiteDomain(domain) || publicVerificationOrigin(emailLinkOrigin);
    if (!origin) throw new Error("请先配置公网 HTTPS 站点域名，或设置 GITHUB_OAUTH_CALLBACK_URL");
    callback = new URL("/api/deploy-status/github/callback", origin);
  }
  if (callback.origin !== requestOrigin) throw new Error("GitHub 回调地址与当前访问域名不同；请通过回调域名访问后重试");
  return callback.toString();
}
