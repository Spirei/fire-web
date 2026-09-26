"use client";
import { useEffect, useRef, useState } from "react";
import SettingsHeader from "@/components/SettingsHeader";
import { passkeyError, passkeyRequest } from "@/lib/passkeyClient";
import { appConfirm, appPrompt } from "@/lib/appDialog";

type Config = { enabled: boolean; origin: string; name: string };
type Key = { id: string; name: string; rpID: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };
export default function PasskeySettings({ admin }: { admin: boolean }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config>({ enabled: false, origin: "", name: "Fire" });
  const [keys, setKeys] = useState<Key[]>([]);
  const [totp, setTotp] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  const [origin, setOrigin] = useState("");
  const lock = useRef(false);
  async function load() {
    const [configRes, keysRes] = await Promise.all([fetch("/api/auth/passkeys/config", { cache: "no-store" }), fetch("/api/auth/passkeys", { cache: "no-store" })]);
    if (!configRes.ok || !keysRes.ok) throw new Error("通行密钥信息加载失败，请刷新重试");
    const next = await configRes.json(); const list = await keysRes.json();
    setConfig(next); setDraft(next); setKeys(list.keys); setTotp(list.totpEnabled);
  }
  useEffect(() => {
    setSupported(window.isSecureContext && !!window.PublicKeyCredential);
    setOrigin(window.location.origin);
    void load().catch(error => setMessage(passkeyError(error)));
  }, []);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(passkeyError(error)); }
    finally { setPassword(""); setCode(""); setBusy(false); lock.current = false; }
  }
  async function add() {
    await run(async () => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, requestId } = await passkeyRequest({ action: "register-options", password, code });
      const response = await startRegistration({ optionsJSON: options });
      await passkeyRequest({ action: "register-verify", requestId, response, name: name.trim() || "通行密钥" });
      setName(""); await load(); setMessage("通行密钥已添加，下次可直接验证登录");
    });
  }
  async function save() {
    if (config?.origin && config.origin !== draft.origin.replace(/\/$/, "") && !await appConfirm("更改域名后，原域名的通行密钥无法在新域名使用，需要重新添加。继续保存？", { title: "更改通行密钥域名" })) return;
    await run(async () => {
      await passkeyRequest({ ...draft, currentPassword: password, code }, "PUT", "/api/auth/passkeys/config");
      await load(); setMessage("通行密钥配置已保存");
    });
  }
  async function rename(key: Key) {
    const value = await appPrompt("填写便于识别的名称", { title: "重命名通行密钥", placeholder: key.name });
    if (!value) return;
    await run(async () => { await passkeyRequest({ id: key.id, name: value }, "PATCH"); await load(); setMessage("名称已更新"); });
  }
  async function remove(key: Key) {
    if (!await appConfirm(`删除「${key.name}」后，将退出通过它登录的会话；升级前无法识别来源的旧会话也会退出。若包含当前会话，需要重新登录。密码登录仍可使用。`, { title: "删除通行密钥", danger: true })) return;
    await run(async () => {
      const result = await passkeyRequest({ id: key.id, password, code }, "DELETE");
      if (result.signedOut) { window.location.replace("/login"); return; }
      await load(); setMessage("通行密钥已删除，相关会话已退出");
    });
  }
  const verifiedInput = !!password && (!totp || !!code);
  return <div id="passkeys" className="flex flex-col gap-6">
    <SettingsHeader name="passkeys" title="通行密钥" />
    <p className="text-sm text-muted">用 Face ID、Touch ID、设备 PIN 或密码管理器验证登录。支持 iCloud 钥匙串、Bitwarden、1Password 等，无需输入登录密码。</p>
    {message && <p role="status" className="rounded-xl border border-edge bg-bg-gray p-3 text-sm text-ink">{message}</p>}
    {!config && <button className="btn btn-ghost self-start" type="button" onClick={() => void load().catch(error => setMessage(passkeyError(error)))}>重新加载</button>}
    {admin && config && <section className="rounded-2xl border border-edge p-4 sm:p-5">
      <h3 className="font-semibold">站点配置</h3>
      <div className="mt-4 flex items-center justify-between gap-4"><span className="text-sm">启用通行密钥登录</span>
        <button type="button" role="switch" aria-label="启用通行密钥登录" aria-checked={draft.enabled} disabled={busy} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`relative h-5 w-9 flex-none rounded-full transition-colors duration-300 ${draft.enabled ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}>
          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow transition-transform duration-300" style={{ backgroundColor: "#fff", transform: draft.enabled ? "translateX(16px)" : "translateX(0)", transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }} />
        </button>
      </div>
      <label className="mt-4 flex flex-col gap-2 text-sm">站点 HTTPS 地址<input className="field w-full" type="url" value={draft.origin} onChange={e => setDraft({ ...draft, origin: e.target.value })} placeholder="https://fire.example.com" disabled={busy} /></label>
      <label className="mt-4 flex flex-col gap-2 text-sm">验证时显示的站点名称<input className="field w-full" value={draft.name} maxLength={64} onChange={e => setDraft({ ...draft, name: e.target.value })} disabled={busy} /></label>
      <p className="mt-3 text-xs text-muted">每个部署独立配置域名。更换域名后需重新添加通行密钥；已有密钥不会被自动删除。</p>
      <button type="button" className="btn btn-ghost mt-4" disabled={busy || !verifiedInput} onClick={save}>保存站点配置</button>
    </section>}
    <section className="rounded-2xl border border-edge p-4 sm:p-5">
      <h3 className="font-semibold">安全验证</h3>
      <p className="mt-1 text-xs text-muted">添加、删除密钥或修改站点配置时，需要确认是你本人。</p>
      <label className="mt-4 flex flex-col gap-2 text-sm">当前密码<input className="field w-full" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
      {totp && <label className="mt-4 flex flex-col gap-2 text-sm">二次验证码或备用码<input className="field w-full" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label>}
    </section>
    <section className="rounded-2xl border border-edge p-4 sm:p-5">
      <h3 className="font-semibold">我的通行密钥</h3>
      {keys.length === 0 && <p className="mt-3 text-sm text-muted">尚未添加通行密钥</p>}
      <ul className="divide-y divide-edge">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0"><p className="break-all font-medium">{key.name}</p><p className="mt-1 break-all text-xs text-muted">{key.rpID} · {key.backedUp ? "支持同步且已备份" : "设备或密码管理器保管"}</p><p className="mt-1 text-xs text-muted">{key.lastUsedAt ? `最近使用：${new Date(key.lastUsedAt).toLocaleString()}` : `添加于：${new Date(key.createdAt).toLocaleString()}`}</p></div>
        <div className="flex gap-2"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => rename(key)}>重命名</button><button className="btn btn-ghost btn-sm !text-up" disabled={busy || !verifiedInput} onClick={() => remove(key)}>删除</button></div>
      </li>)}</ul>
      {!config?.enabled ? <p className="mt-4 text-sm text-muted">管理员启用后即可添加和使用通行密钥。</p> : !supported || origin !== config.origin ? <p className="mt-4 text-sm text-muted">请使用支持通行密钥的浏览器，通过 <a className="underline" href={config.origin}>{config.origin}</a> 添加。</p> : <>
        <label className="mt-4 flex flex-col gap-2 text-sm">密钥名称<input className="field w-full" value={name} maxLength={64} onChange={e => setName(e.target.value)} placeholder="例如：iCloud、Bitwarden、随身安全密钥" disabled={busy} /></label>
        <button type="button" className="btn btn-ghost mt-4" disabled={busy || !verifiedInput || keys.length >= 20} onClick={add}>{busy ? "处理中…" : "添加通行密钥"}</button>
      </>}
      <p className="mt-3 text-xs text-muted">通行密钥登录会要求设备解锁验证，无需再输入 TOTP。密码登录及其二次验证仍可使用。</p>
    </section>
  </div>;
}
