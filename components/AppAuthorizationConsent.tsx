"use client";

import { useEffect, useRef, useState } from "react";
import type { AppAuthorization } from "@/lib/appAuth";
import AppConnectionShell from "@/components/AppConnectionShell";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import type { AppConnectionBrand } from "@/lib/appConnectionBrand";
import { SubNavIcon } from "@/components/SettingsHeader";
import { validAppAuthorizationCallback } from "@/lib/appConnectionChecks";
import { readLimitedResponseJson } from "@/lib/requestBody";

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
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const writable = authorization.scope.split(" ").includes("portfolio.write");

  async function decide(nextDecision: "allow" | "deny") {
    if (inFlight.current || callback) return;
    inFlight.current = true; setBusy(nextDecision); setError("");
    const controller = new AbortController(); operation.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetch("/api/v1/auth/authorize", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...authorization, decision: nextDecision }), signal: controller.signal });
      const body = await readLimitedResponseJson<any>(response, 8192);
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok || body?.code !== 0 || !validAppAuthorizationCallback(body.data?.callback, authorization.state, nextDecision)) throw new Error("授权结果无效，请返回 App 重新连接");
      if (controller.signal.aborted) return;
      setDecision(nextDecision); setCallback(body.data.callback);
      window.location.assign(body.data.callback);
    } catch (e) { if (!controller.signal.aborted || timedOut) setError(timedOut ? "授权超时，请返回 App 重新连接" : e instanceof Error ? e.message : "授权失败，请重试"); }
    finally { clearTimeout(timer); inFlight.current = false; if (!controller.signal.aborted || timedOut) setBusy(null); }
  }

  return <AppConnectionShell serverName={serverName} brand={brand}>
    <div className="app-connection-intro">
      <AppConnectionIcon src={brand.appIcon} />
      <h1>{callback ? decision === "allow" ? `已允许连接 ${brand.appName}` : "已取消授权" : `使用 ${brand.siteName} 账户连接 ${brand.appName}`}</h1>
      <p>{authorization.device_name}</p>
    </div>
    {!callback && <>
      <div className="app-consent-account">
        <span className="app-consent-avatar" aria-hidden="true">{avatar && !avatarFailed ? <img src={avatar} alt="" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} /> : account.slice(0, 1).toUpperCase()}</span>
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
