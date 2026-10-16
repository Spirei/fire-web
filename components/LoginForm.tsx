"use client";

import VisibilityIcon from "@/components/VisibilityIcon";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PasskeyLoginButton from "@/components/PasskeyLoginButton";
import EmailRecoveryForm from "@/components/EmailRecoveryForm";
import PasswordStrength from "@/components/PasswordStrength";
import { isCompleteBackupCode, isSixDigitTotp, normalizeBackupInput, normalizeTotpDigits } from "@/lib/totpInput";

type Mode = "login" | "register";
type AuthStep = Mode | "factor" | "register-email";
// Memory only. Closing and reopening a form does not immediately bypass a server pause.
const retryDeadlines = new Map<AuthStep, number>();
function retryDelay(response: Response) {
  const raw = response.headers.get("retry-after") || "";
  const value = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(value) ? Math.min(86400, Math.max(1, value)) : 60;
}

export default function LoginForm({ onClose, returnTo = "/records" }: { onClose?: () => void; returnTo?: string }) {
  const authorizationLogin = returnTo.startsWith("/app/authorize?");
  const destination = authorizationLogin || returnTo === "/app/devices" ? returnTo : "/records";
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [loginType, setLoginType] = useState<"username" | "email">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [totpTicket, setTotpTicket] = useState("");
  const [emailRegistrationSupported, setEmailRegistrationSupported] = useState(false);
  const [registrationEmail, setRegistrationEmail] = useState<{challenge: string; email: string; expiresAt: number} | null>(null);
  const [registrationCode, setRegistrationCode] = useState("");
  const emailRegistration = mode === "register" && username.includes("@");
  const submitting = useRef(false);
  const [clock, setClock] = useState(0);
  const step: AuthStep = totpTicket ? "factor" : emailRegistration && !registrationEmail ? "register-email" : mode;
  const retrySeconds = Math.max(0, Math.ceil(((retryDeadlines.get(step) || 0) - (clock || Date.now())) / 1000));
  const emailSendSeconds = Math.max(0, Math.ceil(((retryDeadlines.get("register-email") || 0) - (clock || Date.now())) / 1000));
  function pause(response: Response, action: AuthStep) {
    if (response.status === 429) {
      retryDeadlines.set(action, Math.max(retryDeadlines.get(action) || 0, Date.now() + retryDelay(response) * 1000));
      setClock(Date.now());
    }
  }
  useEffect(() => {
    setClock(Date.now());
    if ((retryDeadlines.get(step) || 0) <= Date.now() && (retryDeadlines.get("register-email") || 0) <= Date.now()) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step, retrySeconds > 0, emailSendSeconds > 0]);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const totpAutoTried = useRef("");
  const totpSubmitting = useRef(false);
  const [allowRegister, setAllowRegister] = useState(true);
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) router.replace(destination);
      })
      .catch(() => {
        // 超时 / 5xx 保持登录表单，不把瞬时失败当成已登录。
      });
    fetch("/api/settings/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings && typeof data.settings.allowRegister === "boolean") {
          setAllowRegister(data.settings.allowRegister);
          setEmailRegistrationSupported(data.settings.emailRegistration === true);
        }
      })
      .catch(() => {});
  }, [router, destination]);

  const formValid = useMemo(
    () => totpTicket
      ? (useBackupCode ? isCompleteBackupCode(totpCode) : isSixDigitTotp(totpCode))
      : emailRegistration && !registrationEmail ? emailRegistrationSupported && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim())
      : username.trim().length > 0 && password.length > 0 && (mode === "login" || confirm.length > 0) && (!emailRegistration || /^\d{6}$/.test(registrationCode)),
    [username, password, mode, confirm, totpTicket, totpCode, useBackupCode, emailRegistration, registrationEmail, emailRegistrationSupported, registrationCode]
  );

  async function completeTotp(code: string) {
    if (!totpTicket || totpSubmitting.current || submitting.current || loading || (retryDeadlines.get("factor") || 0) > Date.now()) return;
    totpSubmitting.current = true; submitting.current = true;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: totpTicket, code })
      });
      pause(res, "factor");
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = data?.error || "验证失败";
        if (/过期|次数过多|失效/.test(message)) {
          setTotpTicket("");
          setTotpCode("");
          setUseBackupCode(false);
        }
        throw new Error(message);
      }
      onClose?.();
      router.push(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证失败");
    } finally {
      totpSubmitting.current = false; submitting.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!totpTicket || useBackupCode || loading) return;
    if (!isSixDigitTotp(totpCode)) {
      totpAutoTried.current = "";
      return;
    }
    if (totpAutoTried.current === totpCode) return;
    totpAutoTried.current = totpCode;
    void completeTotp(totpCode);
  }, [totpCode, totpTicket, useBackupCode, loading]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current || loading || (retryDeadlines.get(step) || 0) > Date.now()) return;
    setError("");
    if (mode === "register" && (!emailRegistration || registrationEmail) && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (totpTicket) {
      void completeTotp(totpCode);
      return;
    }
    submitting.current = true; setLoading(true);
    try {
      if (emailRegistration && !emailRegistrationSupported) throw new Error("邮箱注册暂不可用");
      const requestingCode = emailRegistration && !registrationEmail;
      if (emailRegistration && registrationEmail && registrationEmail.expiresAt <= Date.now()) {
        setRegistrationEmail(null); setRegistrationCode(""); throw new Error("验证码已失效，请重新获取");
      }
      const path = emailRegistration ? `/api/auth/register/email/${requestingCode ? "request" : "confirm"}` : `/api/auth/${mode === "login" ? "login" : "register"}`;
      const payload = emailRegistration ? requestingCode ? {email: username.trim()} : {email: username.trim(), challenge: registrationEmail!.challenge, code: registrationCode, password} : {username, password};
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      pause(res, requestingCode ? "register-email" : mode);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "操作失败");
      if (requestingCode) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(data?.challenge || "") || data.email !== username.trim().toLowerCase() || data.expires_in !== 1800 || data.retry_after !== 60) throw new Error("验证码发送未确认，请稍后重试");
        setRegistrationEmail({challenge: data.challenge, email: data.email, expiresAt: Date.now() + data.expires_in * 1000});
        setRegistrationCode(""); retryDeadlines.set("register-email", Date.now() + 60_000); setClock(Date.now()); return;
      }
      if (emailRegistration && (data?.user?.email !== username.trim().toLowerCase() || data?.user?.emailVerified !== true || data?.user?.role !== "user")) throw new Error("邮箱绑定未确认，请尝试登录");
      if (data?.requires2fa && data?.ticket) {
        setTotpTicket(data.ticket);
        setTotpCode("");
        setUseBackupCode(false);
        totpAutoTried.current = "";
        setPassword("");
        return;
      }
      // 登录/注册成功：先关闭弹窗，再跳转到记录页，避免弹窗常驻不消失。
      onClose?.();
      router.push(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      submitting.current = false; setLoading(false);
    }
  }

  const inputCls =
    "w-full h-[46px] rounded-[10px] border border-edge-strong bg-white px-3.5 text-[14px] text-ink outline-none transition-shadow placeholder:text-faint focus:border-[#1FBE9E] focus:shadow-[0_0_0_3px_rgba(31,190,158,.18)] dark:bg-[#161b26] dark:text-white";

  if (recovering) return <div className="w-full px-6 py-7 sm:px-9"><EmailRecoveryForm initialLogin={username} onBack={() => { setRecovering(false); setError(""); }} /></div>;

  return (
    <div className="flex w-full flex-col px-6 py-7 sm:px-9">
      {/* 标题行：登录 + 关闭 */}
      {(!authorizationLogin || totpTicket || mode === "register") && <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-0.3px] text-ink">
            {totpTicket ? "二次验证" : mode === "login" ? "登录" : "注册账号"}
          </h1>
          {(!authorizationLogin || totpTicket) && <p className="mt-1 text-[13px] text-muted">
            {totpTicket ? (useBackupCode ? "请输入一次性备用码" : "请输入验证器中的 6 位数字") : mode === "login" ? "欢迎回来，继续你的投资记录" : "创建账号，数据独立保存在服务端"}
          </p>}
        </div>
        {!authorizationLogin && <button
          type="button"
          onClick={() => (onClose ? onClose() : router.push("/"))}
          aria-label="关闭"
          className="grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:bg-bg-gray hover:text-ink"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>}
      </div>}

      {/* 登录方式：用户名 / 邮箱 */}
      {mode === "login" && !totpTicket && !recovering && (
        <div className="mt-6 grid grid-cols-2 gap-1 rounded-full bg-bg-gray p-1">
          {([["username", "用户名登录"], ["email", "邮箱登录"]] as const).map(([key, label]) => (
            <button aria-pressed={loginType === key}
              key={key}
              type="button"
              onClick={() => { setLoginType(key); setError(""); }}
              className={`rounded-full px-3 py-2 text-[13px] font-semibold transition-colors ${
                loginType === key ? "bg-white text-ink shadow-sm dark:bg-[#1c2330]" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "login" && !totpTicket && !recovering && <PasskeyLoginButton disabled={loading} onBusy={setLoading} onError={setError} onSuccess={() => { onClose?.(); router.push(destination); router.refresh(); }} />}
      <form onSubmit={submit} className="mt-7 flex flex-col gap-4">
        {totpTicket ? (
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
            {useBackupCode ? "备用码" : "验证码"}
            <input
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              inputMode={useBackupCode ? "text" : "numeric"}
              maxLength={useBackupCode ? 19 : 6}
              value={totpCode}
              onChange={(e) => setTotpCode(useBackupCode ? normalizeBackupInput(e.target.value) : normalizeTotpDigits(e.target.value))}
              placeholder={useBackupCode ? "xxxx-xxxx-xxxx-xxxx" : "6 位数字"}
              required
              className={`${inputCls} text-center font-mono ${useBackupCode ? "tracking-[0.12em]" : "text-[20px] tracking-[0.35em]"}`}
            />
          </label>
        ) : null}
        {!totpTicket && !recovering && (
        <>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          {mode === "login" ? (loginType === "email" ? "邮箱" : "用户名") : emailRegistrationSupported ? "用户名或邮箱" : "用户名"}
          <input
            type={mode === "login" && loginType === "email" ? "email" : "text"}
            maxLength={mode === "register" && !emailRegistrationSupported ? 20 : 254}
            value={username}
            disabled={loading}
            onChange={(e) => { setUsername(e.target.value); if (registrationEmail && e.target.value.trim().toLowerCase() !== registrationEmail.email) {setRegistrationEmail(null);setRegistrationCode("");} }}
            placeholder={
              mode === "register"
                ? emailRegistrationSupported ? "请输入用户名或邮箱" : "3-20 位字母、数字、下划线或中文"
                : loginType === "email"
                  ? "请输入邮箱"
                  : "请输入用户名"
            }
            required
            className={inputCls}
          />
        </label>

        {emailRegistration && registrationEmail && <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          邮箱验证码
          <input value={registrationCode} onChange={e => setRegistrationCode(e.target.value.replace(/\D/g, "").slice(0,6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="六位验证码" className={inputCls} required />
          <button type="button" disabled={loading || emailSendSeconds > 0} onClick={() => {setRegistrationEmail(null);setRegistrationCode("");}} className="self-end text-[13px] text-muted disabled:opacity-50">{emailSendSeconds > 0 ? `${emailSendSeconds} 秒后重试` : "重新获取验证码"}</button>
        </label>}
        {(!emailRegistration || registrationEmail) && <>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          密码
          <div className="relative">
            <input
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "至少 8 位，含字母和数字" : "请输入密码"}
              maxLength={128}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              className={`${inputCls} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              title={showPwd ? "隐藏密码" : "查看密码"}
              aria-label={showPwd ? "隐藏密码" : "查看密码"}
              className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-faint transition-colors hover:bg-brand-hover hover:text-ink"
            >
              <VisibilityIcon hidden={showPwd} className="h-[18px] w-[18px]" />
            </button>
          </div>
          {mode === "register" && <PasswordStrength password={password} userInputs={[username]} />}
        </label>

        {mode === "register" && (
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
            确认密码
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                maxLength={128}
                autoComplete="new-password"
                required
                className={`${inputCls} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                title={showConfirm ? "隐藏密码" : "查看密码"}
                aria-label={showConfirm ? "隐藏密码" : "查看密码"}
                className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-faint transition-colors hover:bg-brand-hover hover:text-ink"
              >
                <VisibilityIcon hidden={showConfirm} className="h-[18px] w-[18px]" />
              </button>
            </div>
          </label>
        )}
        </>}
        </>
        )}

        {error && <p className="rounded-[10px] bg-up-bg px-3.5 py-2.5 text-[13px] text-up">{error}</p>}

        {/* 主按钮：填写完整才可点，未填呈禁用 */}
        <button
          type="submit"
          disabled={loading || !formValid || retrySeconds > 0}
          className="mt-1 h-[46px] rounded-[10px] bg-[#1FBE9E] text-[15px] font-bold text-white transition-all duration-200 hover:bg-[#17A887] active:scale-[.98] disabled:cursor-not-allowed disabled:bg-bg-gray disabled:text-faint dark:disabled:bg-[#263040] dark:disabled:text-[#aab4c2]"
        >
          {retrySeconds > 0 ? (retrySeconds >= 3600 ? `${Math.ceil(retrySeconds / 3600)} 小时后重试` : retrySeconds >= 60 ? `${Math.ceil(retrySeconds / 60)} 分钟后重试` : `${retrySeconds} 秒后重试`) : loading ? "请稍候…" : totpTicket ? "验证并登录" : mode === "login" ? "登录" : emailRegistration ? registrationEmail ? "验证并注册" : "获取验证码" : "注册并登录"}
        </button>


        {totpTicket && (
          <p className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[13px] text-muted">
            <button
              type="button"
              onClick={() => { setUseBackupCode((v) => !v); setTotpCode(""); setError(""); totpAutoTried.current = ""; }}
              className="font-semibold text-ink underline-offset-4 hover:underline"
            >
              {useBackupCode ? "使用验证器验证码" : "使用备用码"}
            </button>
            <button type="button" onClick={() => { setTotpTicket(""); setTotpCode(""); setUseBackupCode(false); setError(""); }} className="font-semibold text-ink underline-offset-4 hover:underline">返回账号密码</button>
          </p>
        )}

        {mode === "login" && !totpTicket && !recovering && (
          <button type="button" onClick={() => { setRecovering(true); setPassword(""); setConfirm(""); setError(""); }} className="text-center text-[13px] font-semibold text-ink underline-offset-4 hover:underline">忘记密码？</button>
        )}


        {allowRegister && !totpTicket && !recovering && (
          <p className="mt-1 text-center text-[13px] text-muted">
            {mode === "login" ? (
              <>
                没有账号？
                <button type="button" onClick={() => { setMode("register"); setRegistrationEmail(null); setRegistrationCode(""); setPassword(""); setConfirm(""); setError(""); }} className="ml-1 font-semibold text-ink underline-offset-4 hover:underline">去注册</button>
              </>
            ) : (
              <>
                已有账号？
                <button type="button" onClick={() => { setMode("login"); setRegistrationEmail(null); setRegistrationCode(""); setPassword(""); setConfirm(""); setError(""); }} className="ml-1 font-semibold text-ink underline-offset-4 hover:underline">去登录</button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
