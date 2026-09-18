"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "login" | "register";

export default function LoginForm({ onClose }: { onClose?: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [loginType, setLoginType] = useState<"username" | "email">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [totpTicket, setTotpTicket] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [allowRegister, setAllowRegister] = useState(true);
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) router.replace("/records");
      })
      .catch(() => {
        // 超时 / 5xx 保持登录表单，不把瞬时失败当成已登录。
      });
    fetch("/api/settings/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings && typeof data.settings.allowRegister === "boolean") {
          setAllowRegister(data.settings.allowRegister);
        }
      })
      .catch(() => {});
  }, [router]);

  const formValid = useMemo(
    () => totpTicket ? totpCode.replace(/\s/g, "").length === 6 || totpCode.replace(/[^a-f0-9]/gi, "").length >= 8 : username.trim().length > 0 && password.length > 0 && (mode === "login" || confirm.length > 0),
    [username, password, mode, confirm, totpTicket, totpCode]
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      if (totpTicket) {
        const res = await fetch("/api/auth/login/totp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket: totpTicket, code: totpCode })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "验证失败");
        onClose?.();
        router.push("/records");
        return;
      }
      const res = await fetch(`/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "操作失败");
      if (data?.requires2fa && data?.ticket) {
        setTotpTicket(data.ticket);
        setTotpCode("");
        return;
      }
      // 登录/注册成功：先关闭弹窗，再跳转到记录页，避免弹窗常驻不消失。
      onClose?.();
      router.push("/records");
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full h-[46px] rounded-[10px] border border-edge-strong bg-white px-3.5 text-[14px] text-ink outline-none transition-shadow placeholder:text-faint focus:border-[#1FBE9E] focus:shadow-[0_0_0_3px_rgba(31,190,158,.18)] dark:bg-[#161b26] dark:text-white";

  return (
    <div className="flex w-full flex-col px-6 py-7 sm:px-9">
      {/* 标题行：登录 + 关闭 */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-0.3px] text-ink">
            {totpTicket ? "二次验证" : mode === "login" ? "登录" : "注册账号"}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {totpTicket ? "请输入验证器中的 6 位数字，或备用码" : mode === "login" ? "欢迎回来，继续你的投资记录" : "创建账号，数据独立保存在服务端"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => (onClose ? onClose() : router.push("/"))}
          aria-label="关闭"
          className="grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:bg-bg-gray hover:text-ink"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* 登录方式：用户名 / 邮箱 */}
      {mode === "login" && !totpTicket && (
        <div className="mt-6 grid grid-cols-2 rounded-full bg-bg-gray p-1">
          {([["username", "用户名登录"], ["email", "邮箱登录"]] as const).map(([key, label]) => (
            <button
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

      <form onSubmit={submit} className="mt-7 flex flex-col gap-4">
        {totpTicket ? (
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
            验证码
            <input
              autoComplete="one-time-code"
              autoFocus
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="6 位验证码或备用码"
              required
              className={`${inputCls} tracking-[0.18em]`}
            />
          </label>
        ) : null}
        {!totpTicket && (
        <>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          {mode === "login" ? (loginType === "email" ? "邮箱" : "用户名") : "用户名"}
          <input
            type={mode === "login" && loginType === "email" ? "email" : "text"}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={
              mode === "register"
                ? "3-20 位字母、数字、下划线或中文"
                : loginType === "email"
                  ? "请输入邮箱"
                  : "请输入用户名"
            }
            required
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          密码
          <div className="relative">
            <input
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "至少 8 位，含字母和数字" : "请输入密码"}
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
              {showPwd ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="m1 1 22 22" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
          </div>
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
                {showConfirm ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="m1 1 22 22" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </label>
        )}
        </>
        )}

        {error && <p className="rounded-[10px] bg-up-bg px-3.5 py-2.5 text-[13px] text-up">{error}</p>}

        {/* 主按钮：填写完整才可点，未填呈禁用 */}
        <button
          type="submit"
          disabled={loading || !formValid}
          className="mt-1 h-[46px] rounded-[10px] bg-[#1FBE9E] text-[15px] font-bold text-white transition-all duration-200 hover:bg-[#17A887] active:scale-[.98] disabled:cursor-not-allowed disabled:bg-bg-gray disabled:text-faint dark:disabled:bg-[#263040] dark:disabled:text-[#aab4c2]"
        >
          {loading ? "请稍候…" : totpTicket ? "验证并登录" : mode === "login" ? "登录" : "注册并登录"}
        </button>

        {totpTicket && (
          <p className="mt-1 text-center text-[13px] text-muted">
            <button type="button" onClick={() => { setTotpTicket(""); setTotpCode(""); setError(""); }} className="font-semibold text-ink underline-offset-4 hover:underline">返回账号密码</button>
          </p>
        )}

        {allowRegister && !totpTicket && (
          <p className="mt-1 text-center text-[13px] text-muted">
            {mode === "login" ? (
              <>
                没有账号？
                <button type="button" onClick={() => { setMode("register"); setError(""); }} className="ml-1 font-semibold text-ink underline-offset-4 hover:underline">去注册</button>
              </>
            ) : (
              <>
                已有账号？
                <button type="button" onClick={() => { setMode("login"); setError(""); }} className="ml-1 font-semibold text-ink underline-offset-4 hover:underline">去登录</button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
