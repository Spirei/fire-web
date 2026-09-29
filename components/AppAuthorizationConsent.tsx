"use client";

import { useRef, useState } from "react";
import type { AppAuthorization } from "@/lib/appAuth";
import AppConnectionShell from "@/components/AppConnectionShell";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import type { AppConnectionBrand } from "@/lib/appConnectionBrand";
import { SubNavIcon } from "@/components/SettingsHeader";

export default function AppAuthorizationConsent({ authorization, account, username, avatar, serverName, brand }: {
  authorization: AppAuthorization; account: string; username: string; avatar: string; serverName: string; brand: AppConnectionBrand;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [callback, setCallback] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const inFlight = useRef(false);
  const writable = authorization.scope.split(" ").includes("portfolio.write");

  async function decide(nextDecision: "allow" | "deny") {
    if (inFlight.current || callback) return;
    inFlight.current = true; setBusy(nextDecision); setError("");
    try {
      const response = await fetch("/api/v1/auth/authorize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...authorization, decision: nextDecision }) });
      const body = await response.json();
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok || body.code !== 0 || typeof body.data?.callback !== "string") throw new Error(body.message || "授权失败，请重试");
      setDecision(nextDecision); setCallback(body.data.callback);
      window.location.assign(body.data.callback);
    } catch (e) { setError(e instanceof Error ? e.message : "授权失败，请重试"); }
    finally { inFlight.current = false; setBusy(null); }
  }

  return <AppConnectionShell serverName={serverName} brand={brand}>
    <div className="app-connection-intro">
      <AppConnectionIcon src={brand.appIcon} />
      <h1>{callback ? decision === "allow" ? `已允许连接 ${brand.appName}` : "已取消授权" : `使用 ${brand.siteName} 账户连接 ${brand.appName}`}</h1>
      <p>{authorization.device_name}</p>
    </div>
    {!callback && <>
      <div className="app-consent-account">
        <span className="app-consent-avatar" aria-hidden="true">{avatar && !avatarFailed ? <img src={avatar} alt="" onError={() => setAvatarFailed(true)} /> : account.slice(0, 1).toUpperCase()}</span>
        <div><strong>{account}</strong>{username !== account && <span>{username}</span>}</div>
        <SubNavIcon name="account" className="app-consent-account-check" />
      </div>
      <section className="app-consent-permissions" aria-labelledby="app-permissions-title">
        <h2 id="app-permissions-title">允许 {brand.appName}</h2>
        <div className="app-consent-permission"><SubNavIcon name="stocks" /><span><strong>查看投资数据</strong><small>持仓、自选、订单与资金记录</small></span></div>
        {writable && <div className="app-consent-permission"><SubNavIcon name="pen" /><span><strong>管理投资数据</strong><small>新增、修改和删除你的投资记录</small></span></div>}
      </section>
    </>}
    {error && <p role="alert" className="app-connection-error">{error}</p>}
    <div className="app-connection-actions" aria-busy={!!busy}>
      {callback ? <a className="app-connection-button is-primary" href={callback}>返回 {brand.appName}</a> : <>
        <button type="button" disabled={!!busy} onClick={() => void decide("deny")} className="app-connection-button">{busy === "deny" ? "正在取消…" : "取消"}</button>
        {needsLogin ? <a className="app-connection-button is-primary" href={`/login?next=${encodeURIComponent(`/app/authorize?${new URLSearchParams({ ...authorization }).toString()}`)}`}>重新登录</a> : <button type="button" disabled={!!busy} onClick={() => void decide("allow")} className="app-connection-button is-primary">{busy === "allow" ? "正在授权…" : "允许连接"}</button>}
      </>}
    </div>
  </AppConnectionShell>;
}
