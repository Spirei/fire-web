"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import AppModal from "@/components/AppModal";
import SettingsHeader from "@/components/SettingsHeader";
import { passkeyError, passkeyRequest } from "@/lib/passkeyClient";
import { appPrompt } from "@/lib/appDialog";

type Config = { enabled: boolean; origin: string; name: string };
type Key = { id: string; name: string; rpID: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };
type PendingAction = { kind: "save"; config: Config } | { kind: "add" } | { kind: "delete"; key: Key };
const normalizeDraft = (value: Config): Config => ({ ...value, origin: value.origin.trim().replace(/\/$/, ""), name: value.name.trim() });
export default function PasskeySettings({ admin }: { admin: boolean }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config>({ enabled: false, origin: "", name: "Fire" });
  const [keys, setKeys] = useState<Key[]>([]);
  const [totp, setTotp] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(false);
  const [origin, setOrigin] = useState("");
  const lock = useRef(false);
  async function loadKeys() {
    const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
    if (!response.ok) throw new Error("密钥列表加载失败，请重试");
    const list = await response.json();
    setKeys(list.keys); setTotp(list.totpEnabled);
  }
  async function load() {
    setLoading(true); setMessage("");
    try {
      const [response] = await Promise.all([fetch("/api/auth/passkeys/config", { cache: "no-store" }), loadKeys()]);
      if (!response.ok) throw new Error("登录设置加载失败，请重试");
      const next: Config = await response.json();
      setConfig(next); setDraft(next);
    } catch (error) { setMessage(passkeyError(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    setSupported(window.isSecureContext && !!window.PublicKeyCredential);
    setOrigin(window.location.origin);
    void load();
  }, []);
  const normalized = normalizeDraft(draft);
  const dirty = !!config && (normalized.enabled !== config.enabled || normalized.origin !== normalizeDraft(config).origin || normalized.name !== config.name.trim());
  const canAdd = !!config?.enabled && supported && origin === config.origin && keys.length < 20;
  const actionLabel = pending?.kind === "save" ? "保存设置" : pending?.kind === "delete" ? "删除密钥" : "添加密钥";
  const domainChanged = pending?.kind === "save" && !!config?.origin && config.origin !== pending.config.origin;
  function begin(action: PendingAction) {
    if (lock.current || pending) return;
    setPassword(""); setCode(""); setName(""); setVerificationError(""); setMessage(""); setPending(action);
  }
  function closeVerification() {
    if (lock.current) return;
    setPending(null); setPassword(""); setCode(""); setName(""); setVerificationError("");
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dirty) begin({ kind: "save", config: normalized });
  }
  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || lock.current || !password || (totp && !code.trim())) return;
    const action = pending;
    lock.current = true; setBusy(true); setVerificationError("");
    try {
      if (action.kind === "save") {
        const saved: Config = await passkeyRequest({ ...action.config, currentPassword: password, code }, "PUT", "/api/auth/passkeys/config");
        // The response is the saved state; a second read must not turn a successful save into a failure.
        setConfig(saved); setDraft(saved); setMessage("已保存");
      } else if (action.kind === "add") {
        const { startRegistration } = await import("@simplewebauthn/browser");
        const { options, requestId } = await passkeyRequest({ action: "register-options", password, code });
        const response = await startRegistration({ optionsJSON: options });
        await passkeyRequest({ action: "register-verify", requestId, response, name: name.trim() || "通行密钥" });
        setMessage("通行密钥已添加");
        await loadKeys().catch(() => setMessage("通行密钥已添加，列表刷新失败，请刷新页面"));
      } else {
        const result = await passkeyRequest({ id: action.key.id, password, code }, "DELETE");
        if (result.signedOut) { window.location.replace("/login"); return; }
        setKeys(current => current.filter(key => key.id !== action.key.id));
        setMessage("密钥已删除，相关登录已退出");
      }
      setPending(null); setName("");
    } catch (error) { setVerificationError(passkeyError(error)); }
    finally { setPassword(""); setCode(""); setBusy(false); lock.current = false; }
  }
  async function rename(key: Key) {
    if (lock.current || pending) return;
    const value = await appPrompt("填写便于识别的名称", { title: "重命名", placeholder: key.name });
    const nextName = value?.trim().slice(0, 64);
    if (!nextName || nextName === key.name || lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      await passkeyRequest({ id: key.id, name: nextName }, "PATCH");
      setKeys(current => current.map(item => item.id === key.id ? { ...item, name: nextName } : item));
      setMessage("名称已更新");
    } catch (error) { setMessage(passkeyError(error)); }
    finally { setBusy(false); lock.current = false; }
  }
  return <div id="passkeys" className="flex flex-col gap-6">
    <SettingsHeader name="passkeys" title="通行密钥" />
    <p className="text-sm text-muted">使用设备解锁或密码管理器登录。</p>
    {message && <p role="status" className="rounded-xl border border-edge bg-bg-gray p-3 text-sm text-ink">{message}</p>}
    {loading ? <p role="status" className="text-sm text-muted">加载中…</p> : !config ? <button className="btn btn-line btn-sm self-start" type="button" onClick={() => void load()}>重试</button> : <>
    {admin && <section className="rounded-2xl border border-edge p-4 sm:p-5">
      <form onSubmit={save}>
      <div className="flex items-center justify-between gap-4"><h3 className="font-semibold">登录设置</h3>
        <button type="button" role="switch" aria-label="启用通行密钥登录" aria-checked={draft.enabled} disabled={busy || !!pending} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`relative h-5 w-9 flex-none rounded-full transition-colors duration-300 ${draft.enabled ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}>
          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow transition-transform duration-300" style={{ backgroundColor: "#fff", transform: draft.enabled ? "translateX(16px)" : "translateX(0)", transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }} />
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">{config.enabled ? "已启用通行密钥登录" : "尚未启用通行密钥登录"}</p>
      <label className="mt-4 flex flex-col gap-2 text-sm">HTTPS 地址<input className="field w-full" type="url" required={draft.enabled} value={draft.origin} onChange={e => setDraft({ ...draft, origin: e.target.value })} placeholder="https://fire.example.com" disabled={busy || !!pending} /></label>
      <label className="mt-4 flex flex-col gap-2 text-sm">站点名称<input className="field w-full" required value={draft.name} maxLength={64} onChange={e => setDraft({ ...draft, name: e.target.value })} disabled={busy || !!pending} /></label>
      <p className="mt-3 text-xs text-muted">更换域名后需重新添加密钥。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending || !dirty || (draft.enabled && !normalized.origin) || !normalized.name}>保存</button>
        {dirty && <><button type="button" className="btn btn-ghost btn-sm disabled:opacity-50" disabled={busy || !!pending} onClick={() => setDraft(config)}>取消</button><span className="text-xs text-muted">未保存</span></>}
      </div>
      </form>
    </section>}
    <section className="rounded-2xl border border-edge p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">我的通行密钥</h3>
        <button type="button" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending || !canAdd} onClick={() => begin({ kind: "add" })}>添加密钥</button>
      </div>
      <p className="mt-2 text-xs text-muted">支持 iCloud、Bitwarden、1Password。</p>
      {keys.length === 0 && <p className="mt-4 text-sm text-muted">尚未添加密钥</p>}
      <ul className="divide-y divide-edge">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0"><p className="break-all font-medium">{key.name}</p><p className="mt-1 break-all text-xs text-muted">{key.rpID} · {key.backedUp ? "已同步备份" : "设备或密码管理器保管"}</p><p className="mt-1 text-xs text-muted">{key.lastUsedAt ? `最近使用：${new Date(key.lastUsedAt).toLocaleString()}` : `添加于：${new Date(key.createdAt).toLocaleString()}`}</p></div>
        <div className="flex gap-2"><button type="button" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending} onClick={() => void rename(key)}>重命名</button><button type="button" className="btn btn-line btn-sm !text-up disabled:opacity-50" disabled={busy || !!pending} onClick={() => begin({ kind: "delete", key })}>删除</button></div>
      </li>)}</ul>
      {!config.enabled ? <p className="mt-4 text-xs text-muted">{admin ? "启用并保存登录设置后，即可添加。" : "管理员启用后即可添加。"}</p> : origin !== config.origin ? <p className="mt-4 text-xs text-muted">请访问 <a className="break-all underline" href={config.origin}>{config.origin}</a> 添加。</p> : !supported ? <p className="mt-4 text-xs text-muted">请使用支持通行密钥的浏览器。</p> : keys.length >= 20 ? <p className="mt-4 text-xs text-muted">已达 20 个，请先删除不用的密钥。</p> : null}
    </section>
    </>}
    {pending && <AppModal title={actionLabel} desc={pending.kind === "delete" ? `删除「${pending.key.name}」将退出相关登录及来源不明的旧登录，可能需要重新登录。仍可用密码登录。` : domainChanged ? "更换域名后需重新添加密钥。输入当前密码确认保存。" : "输入当前密码以继续。"} onClose={closeVerification} closeDisabled={busy}>
      <form onSubmit={confirmAction} className="flex flex-col gap-4">
        {pending.kind === "add" && <label className="flex flex-col gap-2 text-sm">密钥名称（选填）<input className="field w-full" value={name} maxLength={64} onChange={e => setName(e.target.value)} placeholder="如 iCloud、Bitwarden" disabled={busy} /></label>}
        <label className="flex flex-col gap-2 text-sm">当前密码<input className="field w-full" type="password" required autoComplete="current-password" data-autofocus autoFocus value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
        {totp && <label className="flex flex-col gap-2 text-sm">二次验证码或备用码<input className="field w-full" required autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label>}
        {verificationError && <p role="alert" className="text-sm text-up">{verificationError}</p>}
        <div className="dialog-actions"><button type="button" className="dialog-btn dialog-btn-ghost" disabled={busy} onClick={closeVerification}>取消</button><button type="submit" className={`dialog-btn ${pending.kind === "delete" ? "dialog-btn-danger" : "dialog-btn-neutral"}`} disabled={busy || !password || (totp && !code.trim())}>{busy ? "处理中…" : actionLabel}</button></div>
      </form>
    </AppModal>}
  </div>;
}
