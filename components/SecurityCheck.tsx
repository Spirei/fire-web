"use client";

import { useEffect, useState } from "react";
import AppModal from "./AppModal";

type Target = "profile" | "totp" | "passkeys";
type Status = { email: boolean; totp: boolean; passkeys: boolean };
const checks: { key: keyof Status; target: Target; title: string; action: string; desc: string; done: string }[] = [
  { key: "passkeys", target: "passkeys", title: "通行密钥", action: "创建通行密钥", desc: "通过指纹或面容安全登录，无需输入密码。", done: "已添加通行密钥" },
  { key: "email", target: "profile", title: "联系信息", action: "绑定邮箱", desc: "添加邮箱，方便找回密码。", done: "已绑定邮箱" },
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
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setStatus(null);
    const timeout = window.setTimeout(() => { setError(true); controller.abort(); }, 15000);
    async function load() {
      try {
        const responses = await Promise.all(["/api/auth/me", "/api/auth/passkeys"].map(url => fetch(url, { cache: "no-store", signal: controller.signal })));
        if (responses.some(response => !response.ok)) throw new Error("status");
        const [account, security] = await Promise.all(responses.map(response => response.json()));
        if (!account.user || !Array.isArray(security.keys) || typeof security.totpEnabled !== "boolean") throw new Error("status");
        if (!controller.signal.aborted) setStatus({ email: Boolean(account.user.email?.trim()), totp: security.totpEnabled, passkeys: security.keys.length > 0 });
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
      <img className="security-check-illustration" src="/icons/security-check.svg" width="100" height="100" alt="" />
      <h2 className="security-check-heading" aria-live="polite">{status ? pending.length ? `你有 ${pending.length} 项推荐操作` : "推荐操作已完成" : summary}</h2>
      {error && <div className="security-check-error"><p>无法读取安全设置，请重试。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新检查</button></div>}
      {pending.length > 0 && <div className="security-check-group">{pending.map(check => row(check, false))}</div>}
      {completed.length > 0 && <div className="security-check-group">{completed.map(check => row(check, true))}</div>}
    </AppModal>}
  </>;
}
