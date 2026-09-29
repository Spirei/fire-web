"use client";
import { useState } from "react";
import type { AppAuthorization } from "@/lib/appAuth";
export default function AppAuthorizationConsent({ authorization, account }: { authorization: AppAuthorization; account: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [callback, setCallback] = useState("");
  async function decide(decision: "allow" | "deny") {
    if (busy || callback) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/auth/authorize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...authorization, decision }) });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !body.data?.callback) throw new Error(body.message || "连接失败");
      setCallback(body.data.callback);
      window.location.assign(body.data.callback);
    } catch (e) { setError(e instanceof Error ? e.message : "连接失败，请重试"); }
    finally { setBusy(false); }
  }
  return <main className="flex min-h-screen items-center justify-center bg-bg-gray px-5 py-10 text-ink">
    <div className="w-full max-w-md rounded-3xl border border-edge bg-white p-7">
      <h1 className="text-2xl font-semibold">连接 Fire App</h1>
      <p className="mt-5 font-semibold">{account}</p><p className="mt-1 text-sm text-muted">{authorization.device_name}</p>
      <p className="mt-6 text-sm text-ink-2">{authorization.scope.includes("portfolio.write") ? "允许查看和修改你的持仓、自选、订单与资金记录。" : "允许查看你的持仓、自选、订单与资金记录。"}</p>
      {error && <p role="alert" className="mt-4 text-sm text-red-500">{error}</p>}
      {callback ? <a className="mt-4 block rounded-full bg-[#0866ff] px-5 py-3 text-center font-semibold text-white" href={callback}>返回 Fire App</a> : <div className="mt-4 flex gap-3">
        <button disabled={busy} onClick={() => void decide("deny")} className="flex-1 rounded-full border border-edge-strong px-5 py-3">取消</button>
        <button disabled={busy} onClick={() => void decide("allow")} className="flex-1 rounded-full bg-[#0866ff] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "正在连接…" : "连接"}</button>
      </div>}
    </div>
  </main>;
}
