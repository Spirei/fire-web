"use client";

import { useEffect, useRef, useState } from "react";
import PasswordResetForm from "@/components/PasswordResetForm";
import { isCompleteBackupCode, normalizeBackupInput } from "@/lib/totpInput";

export default function EmailRecoveryForm({ initialLogin = "", fixedLogin = false, hideTitle = false, emailAvailable = true, totpAvailable = true, onBack, onBusy }: {
  initialLogin?: string; fixedLogin?: boolean; hideTitle?: boolean; emailAvailable?: boolean; totpAvailable?: boolean; onBack?: () => void; onBusy?: (busy: boolean) => void;
}) {
  const [login, setLogin] = useState(initialLogin);
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [method,setMethod]=useState<"email"|"totp">(fixedLogin && totpAvailable ? "totp" : "email");
  const [backup,setBackup]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const deadline = useRef(0);
  const contexts=useRef({email:{challenge:"",deadline:0},totp:{challenge:"",deadline:0}});
  function changeMethod(next:"email"|"totp") {
    contexts.current[method]={challenge,deadline:deadline.current};
    setMethod(next);setChallenge(contexts.current[next].challenge);deadline.current=contexts.current[next].deadline;
    setCooldown(Math.max(0,Math.ceil((deadline.current-Date.now())/1000)));setCode("");setBackup(false);setError("");setMessage("");
  }
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setInterval(() => setCooldown(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [cooldown > 0]);

  async function call(path: string, body: object) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`/api/auth/password-reset/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "操作失败，请重试");
      return data;
    } catch (cause) {
      if (controller.signal.aborted) throw new Error("请求超时，请稍后重试");
      throw cause;
    } finally { clearTimeout(timer); }
  }

  async function perform(verify: boolean) {
    if (inFlight.current || (!verify && cooldown > 0)) return;
    inFlight.current = true;
    setBusy(true); onBusy?.(true); setError("");
    try {
      if (verify) {
        const data = await call("verify", { challenge, code, method });
        if (!data?.token || typeof data.token !== "string") throw new Error("验证失败，请重试");
        if (alive.current) { setToken(data.token); setCode(""); }
      } else {
        const data = await call("request", { login: login.trim(), challenge, method });
        if (!data?.challenge || typeof data.challenge !== "string") throw new Error("发送失败，请重试");
        if (alive.current) {
          setChallenge(data.challenge); setCode(""); setMessage(data.message || "请查看绑定邮箱中的验证码。");
          deadline.current = Date.now() + 60_000; setCooldown(60);
        }
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "操作失败，请重试"); }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); onBusy?.(false); } }
  }

  if (token) return <PasswordResetForm token={token} onBusy={onBusy} onRestart={() => { setToken(""); setChallenge(""); setCode(""); setError(""); }} />;
  const field = "field w-full min-h-[48px] rounded-[12px]";
  return <form onSubmit={event => { event.preventDefault(); void perform(Boolean(challenge)); }} className="flex flex-col gap-4">
    {!hideTitle && <h1 className="text-2xl font-bold text-ink">{challenge ? "输入验证码" : "找回密码"}</h1>}
    <p className="text-[13px] leading-5 text-muted">{method==="totp" ? "使用已配置的 TOTP 验证器或备用码，无需邮箱。" : challenge ? "输入已验证邮箱收到的 6 位验证码，30 分钟内有效。" : "验证码发送至账号的已验证邮箱。"}</p>
    {!challenge && !fixedLogin && <label className="flex flex-col gap-2 text-sm font-semibold text-ink-2">用户名或邮箱<input autoComplete="username" autoFocus value={login} disabled={busy} onChange={event => setLogin(event.target.value)} maxLength={160} required className={field} /></label>}
    {challenge && <label className="flex flex-col gap-2 text-sm font-semibold text-ink-2">{backup?"备用码":method==="totp"?"验证器验证码":"邮箱验证码"}<input autoFocus type="text" inputMode={backup?"text":"numeric"} autoComplete="one-time-code" pattern={backup?undefined:"[0-9]{6}"} maxLength={backup?19:6} value={code} disabled={busy} onChange={event => setCode(backup?normalizeBackupInput(event.target.value):event.target.value.replace(/\D/g, "").slice(0, 6))} required placeholder={backup?"xxxx-xxxx-xxxx-xxxx":"6 位数字"} className={`${field} text-center text-xl font-mono ${backup?"tracking-normal":"tracking-[.3em]"}`} /></label>}
    {message && <p role="status" className="text-[13px] leading-5 text-muted">{message}</p>}
    {error && <p role="alert" className="rounded-[12px] bg-up-bg px-3.5 py-3 text-[13px] leading-5 text-up">{error}</p>}
    <button type="submit" disabled={busy || (challenge ? !(backup?isCompleteBackupCode(code):/^\d{6}$/.test(code)) : !login.trim() || cooldown > 0)} className="btn btn-line min-h-[46px] w-full disabled:opacity-50">{busy ? "请稍候…" : challenge ? "验证并继续" : cooldown ? `${cooldown} 秒后可继续` : method==="totp"?"继续":"发送验证码"}</button>
    {challenge && method==="totp" && <button type="button" disabled={busy} onClick={()=>{setBackup(!backup);setCode("");setError("");}} className="text-sm text-ink">{backup?"使用验证器":"使用备用码"}</button>}
    {challenge && <div className="flex flex-wrap justify-between gap-3 text-[13px]">
      <button type="button" disabled={busy || cooldown > 0} onClick={() => void perform(false)} className="text-ink disabled:text-faint">{cooldown ? `${cooldown} 秒后可重试` : method==="totp"?"重新开始验证":"重新发送"}</button>
      {!fixedLogin && <button type="button" disabled={busy} onClick={() => { setChallenge("");contexts.current={email:{challenge:"",deadline:deadline.current},totp:{challenge:"",deadline:deadline.current}};setCode(""); setMessage(""); setError(""); }} className="text-ink">更换账号</button>}
    </div>}
    {(method === "email" ? totpAvailable : emailAvailable) && <button type="button" disabled={busy} onClick={() => changeMethod(method === "email" ? "totp" : "email")} className="text-center text-sm text-ink">{method === "email" ? "已配置验证器？改用验证器" : "改用邮箱验证码"}</button>}
    {onBack && <button type="button" disabled={busy} onClick={onBack} className="text-center text-sm text-ink">返回登录</button>}
  </form>;
}
