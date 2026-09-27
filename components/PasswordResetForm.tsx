"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

export default function PasswordResetForm({ token, onBusy, onRestart }: { token: string; onBusy?: (busy: boolean) => void; onRestart?: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const valid = useMemo(() => Boolean(token && password.length >= 8 && password === confirm), [token, password, confirm]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !valid) return;
    setError("");
    if (password !== confirm) return setError("两次输入的密码不一致");
    inFlight.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    setBusy(true);
    onBusy?.(true);
    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "重置失败");
      setDone(true);
    } catch (cause) {
      setError(controller.signal.aborted ? "请求超时，请重试" : cause instanceof Error ? cause.message : "重置失败");
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }

  if (done) return <div className="space-y-5 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-light text-2xl text-brand-deep">✓</div><div><h1 className="text-2xl font-extrabold text-ink">密码已更新</h1><p className="mt-2 text-sm text-muted">所有旧登录会话已退出，请使用新密码重新登录。</p></div><Link href="/login" className="inline-flex h-11 items-center justify-center rounded-[10px] bg-[#0866ff] px-6 text-sm font-bold text-white hover:bg-[#075ce5]">返回登录</Link></div>;

  return <form onSubmit={submit} className="space-y-4">
    <div><h1 className="text-2xl font-extrabold text-ink">设置新密码</h1><p className="mt-1.5 text-sm text-muted">至少 8 位，并同时包含字母和数字。</p></div>
    {!token && <p role="alert" className="rounded-[10px] bg-up-bg px-3.5 py-3 text-sm text-up">请先验证身份。</p>}
    <label className="block text-sm font-semibold text-ink-2">新密码<input type="password" value={password} disabled={busy} maxLength={128} onChange={event => setPassword(event.target.value)} autoComplete="new-password" required className="field mt-1.5 w-full" /></label>
    <label className="block text-sm font-semibold text-ink-2">确认新密码<input type="password" value={confirm} disabled={busy} maxLength={128} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" required className="field mt-1.5 w-full" /></label>
    {error && <p role="alert" className="rounded-[10px] bg-up-bg px-3.5 py-3 text-sm text-up">{error}</p>}
    <button type="submit" disabled={busy || !valid} className="h-11 w-full rounded-[10px] bg-[#0866ff] text-sm font-bold text-white transition-colors hover:bg-[#075ce5] disabled:cursor-not-allowed disabled:bg-bg-gray disabled:text-faint">{busy ? "正在更新…" : "更新密码"}</button>
    <Link href="/login" className="block text-center text-sm font-semibold text-ink hover:underline">返回登录</Link>
    {onRestart && <button type="button" disabled={busy} onClick={onRestart} className="block w-full text-center text-sm text-muted">重新验证身份</button>}
  </form>;
}
