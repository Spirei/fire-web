"use client";

import { useEffect, useRef, useState } from "react";
import AppModal from "./AppModal";

type Target = "profile" | "totp" | "passkeys";
type Status = { email: boolean; totp: boolean; passkeys: boolean };
const checks: { key: keyof Status; target: Target; title: string; action: string; desc: string; done: string }[] = [
  { key: "passkeys", target: "passkeys", title: "通行密钥", action: "创建通行密钥", desc: "通过指纹或面容安全登录，无需输入密码。", done: "已添加通行密钥" },
  { key: "email", target: "profile", title: "联系信息", action: "验证邮箱", desc: "绑定并验证邮箱，方便找回密码。", done: "邮箱已验证" },
  { key: "totp", target: "totp", title: "双重验证", action: "开启双重验证", desc: "为密码登录增加一层保护。", done: "已开启双重验证" }
];

function StatusIcon({ complete = false }: { complete?: boolean }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={complete ? "security-check-ok" : "security-check-blue"} aria-hidden="true"><circle cx="12" cy="12" r="9" />{complete ? <path d="m7.5 12 3 3 6-6" /> : <><path d="M12 7v6" /><circle cx="12" cy="16.5" r=".6" fill="currentColor" /></>}</svg>;
}

export default function SecurityCheck({ onNavigate }: { onNavigate: (target: Target) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(false);
  useEffect(() => {
    // Closing an inspected panel should not clear its result or repeat both requests.
    if (!open && loaded.current) return;
    const controller = new AbortController();
    setError(false);
    const timeout = window.setTimeout(() => { setError(true); controller.abort(); }, 15000);
    async function load() {
      try {
        const responses = await Promise.all(["/api/auth/me", "/api/auth/passkeys"].map(url => fetch(url, { cache: "no-store", signal: controller.signal })));
        if (responses.some(response => !response.ok)) throw new Error("status");
        const [account, security] = await Promise.all(responses.map(response => response.json()));
        if (!account.user || !Array.isArray(security.keys) || typeof security.totpEnabled !== "boolean") throw new Error("status");
        if (!controller.signal.aborted) {
          loaded.current = true;
          setStatus({ email: account.user.emailVerified === true, totp: security.totpEnabled, passkeys: security.keys.length > 0 });
        }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { window.clearTimeout(timeout); }
    }
    void load();
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [open, attempt]);
  const pending = status ? checks.filter(check => !status[check.key]) : [];
  const completed = status ? checks.filter(check => status[check.key]) : [];
  const summary = error ? "暂时无法检查" : !status ? "正在检查…" : pending.length ? `${pending.length} 项推荐操作` : "推荐操作已完成";
  function row(check: typeof checks[number], complete: boolean) {
    return <button type="button" className="security-check-row" key={check.key} onClick={() => { setOpen(false); onNavigate(check.target); }}><StatusIcon complete={complete} /><span><strong>{complete ? check.title : check.action}</strong><small>{complete ? check.done : check.desc}</small></span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>;
  }
  return <>
    <div className="sc-row-group security-check-entry"><button type="button" className="sc-setting-row" onClick={() => setOpen(true)}><svg className="security-check-blue" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM12 7v6m0 3v.5" /></svg><span><strong>Fire 安全检查</strong><small className="security-check-blue">{summary}</small></span><span className="sc-chevron" aria-hidden="true">›</span></button></div>
    {open && <AppModal title="Fire 安全检查" size="lg" className="security-check-modal" onClose={() => setOpen(false)}>
      <svg className="security-check-illustration" width="100" height="100" viewBox="0 0 100 100" fill="none" aria-hidden="true"><defs><linearGradient id="fire-security-shield" x1="20" y1="10" x2="77" y2="82" gradientUnits="userSpaceOnUse"><stop stopColor="#9b9cff"/><stop offset=".38" stopColor="#0866ff"/><stop offset="1" stopColor="#00d5f4"/></linearGradient><linearGradient id="fire-security-fold" x1="32" y1="49" x2="60" y2="90" gradientUnits="userSpaceOnUse"><stop stopColor="#1340da"/><stop offset="1" stopColor="#002a98"/></linearGradient></defs><path d="M49 8c-14 0-27 5-35 10v27c0 23 13 37 35 47 22-10 35-24 35-47V18C76 13 63 8 49 8Z" fill="url(#fire-security-shield)"/><path d="M14 36c7 23 21 38 45 46l-10 10C27 82 14 68 14 45Z" fill="url(#fire-security-fold)"/><circle cx="76" cy="64" r="22" fill="white"/><circle cx="76" cy="64" r="17" stroke="#0866ff" strokeWidth="3.5"/><path d="M76 54v12" stroke="#0866ff" strokeWidth="4" strokeLinecap="round"/><circle cx="76" cy="73" r="2.2" fill="#0866ff"/></svg>
      <h2 className="security-check-heading" aria-live="polite">{error ? summary : status ? pending.length ? `你有 ${pending.length} 项推荐操作` : "推荐操作已完成" : summary}</h2>
      {error && <div className="security-check-error"><p>无法读取安全设置，请重试。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新检查</button></div>}
      {!error && pending.length > 0 && <div className="security-check-group">{pending.map(check => row(check, false))}</div>}
      {!error && completed.length > 0 && <div className="security-check-group">{completed.map(check => row(check, true))}</div>}
    </AppModal>}
  </>;
}
