"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import AppModal from "@/components/AppModal";
import { startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { SubNavIcon } from "@/components/SettingsHeader";
import { passkeyError, passkeyRequest, passkeyRead, PasskeyRequestError } from "@/lib/passkeyClient";
import { parsePasskeyConfig, isPublicPasskeyConfig, type PublicPasskeyConfig } from "@/lib/passkeyConfig";
import { appPrompt } from "@/lib/appDialog";

type Config = PublicPasskeyConfig;
type Key = { id: string; name: string; rpID: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };
type PendingAction = { kind: "save"; config: Config } | { kind: "add" } | { kind: "delete"; key: Key };
const normalizeDraft = (value: Config): Config => ({ ...value, origin: value.origin.trim().replace(/\/$/, ""), name: value.name.trim() });
export default function PasskeySettings({ admin, onClose }: { admin: boolean; onClose?: () => void }) {
  const [showConfig, setShowConfig] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [intro, setIntro] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config>({ enabled: false, origin: "", name: "Fire", revision: "" });
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
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [supported, setSupported] = useState(false);
  const [origin, setOrigin] = useState("");
  const lock = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const ceremonyActive = useRef(false);
  async function loadKeys(signal?: AbortSignal) {
    const list = await passkeyRead("/api/auth/passkeys", signal);
    if (!Array.isArray(list.keys) || typeof list.totpEnabled !== "boolean") throw new Error("密钥列表响应异常，请刷新页面");
    if (signal?.aborted) return;
    setKeys(list.keys); setTotp(list.totpEnabled);
  }
  async function load(keepDraft = false) {
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    setLoading(true); setMessage("");
    try {
      const [next] = await Promise.all([passkeyRead("/api/auth/passkeys/config", controller.signal), loadKeys(controller.signal)]);
      if (!isPublicPasskeyConfig(next)) throw new Error("登录设置响应异常，请刷新页面");
      if (controller.signal.aborted) return;
      setConfig(next); if (!keepDraft) setDraft(next);
      setRefreshRequired(false);
      if (keepDraft) setMessage("已刷新，请检查设置和密钥后再操作");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof PasskeyRequestError && error.status === 401) { window.location.assign("/login"); return; }
        setMessage(passkeyError(error));
      }
    }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    setSupported(window.isSecureContext && !!window.PublicKeyCredential);
    setOrigin(window.location.origin);
    void load();
    return () => {
      activeRequest.current?.abort();
      if (ceremonyActive.current) WebAuthnAbortService.cancelCeremony();
    };
  }, []);
  const normalized = normalizeDraft(draft);
  const dirty = !!config && (normalized.enabled !== config.enabled || normalized.origin !== normalizeDraft(config).origin || normalized.name !== config.name.trim());
  const canAdd = !!config?.enabled && supported && origin === config.origin && keys.length < 20;
  const actionLabel = pending?.kind === "save" ? "保存设置" : pending?.kind === "delete" ? "删除密钥" : "创建通行密钥";
  const currentRPID = config?.origin ? new URL(config.origin).hostname : "";
  const domainChanged = pending?.kind === "save" && !!currentRPID && (!pending.config.origin || currentRPID !== new URL(pending.config.origin).hostname);
  function begin(action: PendingAction) {
    if (lock.current || pending || refreshRequired) return;
    setPassword(""); setCode(""); setName(""); setVerificationError(""); setMessage(""); setPending(action);
  }
  function closeVerification() {
    if (lock.current) return;
    setPending(null); setPassword(""); setCode(""); setName(""); setVerificationError("");
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    try { begin({ kind: "save", config: { ...parsePasskeyConfig(draft), revision: config!.revision } }); }
    catch (error) { setMessage(passkeyError(error)); }
  }
  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || lock.current || !password || (totp && !code.trim())) return;
    const action = pending;
    const controller = new AbortController(); activeRequest.current = controller;
    lock.current = true; setBusy(true); setVerificationError("");
    try {
      if (action.kind === "save") {
        const saved = await passkeyRequest({ ...action.config, expectedRevision: action.config.revision, currentPassword: password, code }, "PUT", "/api/auth/passkeys/config", controller.signal);
        if (!isPublicPasskeyConfig(saved)) throw new PasskeyRequestError("保存结果未确认，请刷新页面后再试", 200, true);
        // The response is the saved state; a second read must not turn a successful save into a failure.
        setConfig(saved); setDraft(saved); setMessage("已保存");
      } else if (action.kind === "add") {
        const { options, requestId } = await passkeyRequest({ action: "register-options", password, code }, "POST", "/api/auth/passkeys", controller.signal);
        if (!options || typeof requestId !== "string" || !requestId) throw new Error("验证信息响应异常，请重试");
        ceremonyActive.current = true;
        let response;
        try { response = await startRegistration({ optionsJSON: options }); }
        finally { ceremonyActive.current = false; }
        if (controller.signal.aborted) return;
        const result = await passkeyRequest({ action: "register-verify", requestId, response, name: name.trim() || "通行密钥" }, "POST", "/api/auth/passkeys", controller.signal);
        if (result.ok !== true) throw new PasskeyRequestError("添加结果未确认，请刷新页面后再试", 200, true);
        setMessage("通行密钥已添加");
        await loadKeys(controller.signal).catch(() => { if (!controller.signal.aborted) { setRefreshRequired(true); setMessage("密钥已添加，请刷新确认列表"); } });
      } else {
        const result = await passkeyRequest({ id: action.key.id, password, code }, "DELETE", "/api/auth/passkeys", controller.signal);
        if (result.ok !== true || typeof result.signedOut !== "boolean") throw new PasskeyRequestError("删除结果未确认，请刷新页面后再试", 200, true);
        if (result.signedOut) { window.location.replace("/login"); return; }
        setKeys(current => current.filter(key => key.id !== action.key.id));
        setMessage("密钥已删除，相关登录已退出");
      }
      setPending(null); setName(""); setIntro(false);
    } catch (error) {
      if (!controller.signal.aborted) {
        const text = passkeyError(error);
        if (error instanceof PasskeyRequestError && error.status === 401) { window.location.assign("/login"); return; }
        if (error instanceof PasskeyRequestError && error.needsRefresh) { setRefreshRequired(true); setMessage(text); setPending(null); }
        else { setVerificationError(text); if (text.includes("二次")) setTotp(true); }
      }
    } finally { if (!controller.signal.aborted) { setPassword(""); setCode(""); setBusy(false); } lock.current = false; }
  }
  async function rename(key: Key) {
    if (lock.current || pending || refreshRequired) return;
    const value = await appPrompt("填写便于识别的名称", { title: "重命名", placeholder: key.name });
    const nextName = value?.trim().slice(0, 64);
    if (!nextName || nextName === key.name || lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    const controller = new AbortController(); activeRequest.current = controller;
    try {
      const result = await passkeyRequest({ id: key.id, name: nextName }, "PATCH", "/api/auth/passkeys", controller.signal);
      if (result.ok !== true) throw new PasskeyRequestError("改名结果未确认，请刷新页面后再试", 200, true);
      setKeys(current => current.map(item => item.id === key.id ? { ...item, name: nextName } : item));
      setMessage("名称已更新");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof PasskeyRequestError && error.status === 401) { window.location.assign("/login"); return; }
        setMessage(passkeyError(error)); if (error instanceof PasskeyRequestError && error.needsRefresh) setRefreshRequired(true);
      }
    }
    finally { if (!controller.signal.aborted) setBusy(false); lock.current = false; }
  }
  const content = <div id="passkeys" className="pk-center flex flex-col gap-4">
    <p className="pk-intro">使用安全又方便的通行密钥来替代密码。<button type="button" className="pk-text-link" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>详细了解</button></p>
    {showHelp && <div className="pk-help"><p>通过面容、指纹或设备密码登录，无需输入网站密码。</p><p>可保存在 iCloud 钥匙串、Bitwarden、1Password 等密码管理器中。Fire 不会获取你的面容或指纹。</p></div>}
    {message && <p role="status" className="rounded-xl border border-edge bg-bg-gray p-3 text-sm text-ink">{message}</p>}
    {refreshRequired && <button type="button" className="btn btn-line btn-sm self-start disabled:opacity-50" disabled={loading || busy} onClick={() => void load(true)}>刷新确认</button>}
    {loading ? <p role="status" className="text-sm text-muted">加载中…</p> : !config ? <button className="btn btn-line btn-sm self-start" type="button" onClick={() => void load()}>重试</button> : <>
    {admin && showConfig && <section className="rounded-2xl border border-edge p-4 sm:p-5">
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
        <button type="submit" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending || refreshRequired || !dirty || (draft.enabled && !normalized.origin) || !normalized.name}>保存</button>
        {dirty && <><button type="button" className="btn btn-ghost btn-sm disabled:opacity-50" disabled={busy || !!pending} onClick={() => setDraft(config)}>取消</button><span className="text-xs text-muted">未保存</span></>}
      </div>
      </form>
    </section>}
    <section>
      <button type="button" className="pk-create-row disabled:opacity-50" disabled={busy || !!pending || refreshRequired} onClick={() => setIntro(true)}>创建通行密钥</button>
      <ul className="divide-y divide-edge">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0"><p className="break-all font-medium">{key.name}</p><p className="mt-1 break-all text-xs text-muted">{key.rpID} · {currentRPID && key.rpID !== currentRPID ? "旧域名密钥" : key.backedUp ? "已同步备份" : "设备或密码管理器保管"}</p><p className="mt-1 text-xs text-muted">{key.lastUsedAt ? `最近使用：${new Date(key.lastUsedAt).toLocaleString()}` : `添加于：${new Date(key.createdAt).toLocaleString()}`}</p></div>
        <div className="flex gap-2"><button type="button" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending || refreshRequired} onClick={() => void rename(key)}>重命名</button><button type="button" className="btn btn-line btn-sm !text-up disabled:opacity-50" disabled={busy || !!pending || refreshRequired} onClick={() => begin({ kind: "delete", key })}>删除</button></div>
      </li>)}</ul>
      {!config.enabled ? <p className="mt-4 text-xs text-muted">{admin ? "启用并保存登录设置后，即可添加。" : "管理员启用后即可添加。"}</p> : origin !== config.origin ? <p className="mt-4 text-xs text-muted">请访问 <a className="break-all underline" href={config.origin}>{config.origin}</a> 添加。</p> : !supported ? <p className="mt-4 text-xs text-muted">请使用支持通行密钥的浏览器。</p> : keys.length >= 20 ? <p className="mt-4 text-xs text-muted">已达 20 个，请先删除不用的密钥。</p> : null}
    </section>
    {admin && <button type="button" className="pk-admin-row" aria-expanded={showConfig} onClick={() => setShowConfig(!showConfig)}><SubNavIcon name="site" className="h-4 w-4"/><span>网站登录配置</span><span aria-hidden="true">{showConfig ? "−" : "+"}</span></button>}
    </>}
  </div>;
  return <>
    {!pending && intro ? <AppModal title="下次免密登录" onClose={() => { setIntro(false); onClose?.(); }} className="pk-reference-modal pk-intro-modal" size="lg">
      <button type="button" className="pk-back" aria-label="返回" onClick={() => setIntro(false)}>‹</button>
      <svg className="pk-security-art" viewBox="0 0 360 220" fill="none" aria-hidden="true">
        <defs><linearGradient id="pk-shield" x1="100" y1="20" x2="260" y2="210" gradientUnits="userSpaceOnUse"><stop stopColor="#12c4ee"/><stop offset=".45" stopColor="#0668eb"/><stop offset=".8" stopColor="#2438d7"/><stop offset="1" stopColor="#db97ed"/></linearGradient><linearGradient id="pk-tile" x1="40" y1="0" x2="140" y2="150" gradientUnits="userSpaceOnUse"><stop stopColor="#beff89"/><stop offset=".5" stopColor="#83f0eb"/><stop offset="1" stopColor="#b7a2ff"/></linearGradient><linearGradient id="pk-tile-pink" x1="230" y1="100" x2="320" y2="220" gradientUnits="userSpaceOnUse"><stop stopColor="#85e4ff"/><stop offset=".55" stopColor="#d1aaff"/><stop offset="1" stopColor="#ffdcad"/></linearGradient></defs>
        <path d="M180 32c36 0 61 12 76 20v65c0 50-57 82-76 91-19-9-76-41-76-91V52c15-8 40-20 76-20Z" fill="url(#pk-shield)"/>
        <path d="m145 110 25 24 47-48" stroke="white" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round"/>
        <rect x="45" y="14" width="94" height="98" rx="19" fill="url(#pk-tile)" stroke="#76e9e4" strokeWidth="3" transform="rotate(5 92 63)"/>
        <g stroke="#079ada" strokeWidth="5" strokeLinecap="round"><path d="m72 77 35-35m-35 35 33 5m-20-19 23 3"/><circle cx="73" cy="39" r="2"/><circle cx="73" cy="56" r="2"/><circle cx="108" cy="40" r="2"/><circle cx="109" cy="83" r="2"/></g>
        <rect x="242" y="20" width="53" height="54" rx="12" fill="url(#pk-tile)" transform="rotate(-7 268 47)"/>
        <g stroke="#168fe8" strokeWidth="3" strokeLinecap="round"><path d="M256 48c0-17 26-17 26 0m-21 5V44c0-9 16-9 16 0v10m-11-9v13m6-10v13"/></g>
        <rect x="226" y="95" width="91" height="103" rx="20" fill="url(#pk-tile-pink)" transform="rotate(-5 270 146)"/>
        <g stroke="#3778ed" strokeWidth="5" strokeLinecap="round"><path d="M247 124v-9h10m30 0h10v9m0 40v9h-10m-30 0h-10v-9"/></g><circle cx="272" cy="134" r="10" fill="#327be9"/><path d="M256 160c0-18 32-18 32 0v3h-32Z" fill="#7069ee"/>
        <rect x="83" y="133" width="62" height="63" rx="16" fill="url(#pk-tile-pink)"/><circle cx="108" cy="153" r="7" fill="#159fd8"/><path d="M97 176c0-14 22-14 22 0" stroke="#159fd8" strokeWidth="7"/><circle cx="127" cy="163" r="4" stroke="#159fd8" strokeWidth="3"/><path d="M127 168v10" stroke="#159fd8" strokeWidth="3"/>
      </svg>
      <div className="pk-benefits"><p><SubNavIcon name="passkeys"/><span>使用面容、指纹或设备密码登录，就像解锁设备一样。</span></p><p><SubNavIcon name="account"/><span>你的生物识别信息始终留在设备上，不会分享给 Fire。</span></p></div>
      {!canAdd && <p className="pk-availability">{!config?.enabled ? (admin ? "请先启用网站登录配置。" : "请等待管理员启用通行密钥。") : origin !== config.origin ? <>请访问 <a href={config.origin}>{config.origin}</a> 创建。</> : !supported ? "请在 HTTPS 下使用支持通行密钥的浏览器。" : "已达 20 个密钥，请先移除不再使用的密钥。"}</p>}
      <div className="pk-intro-actions"><button type="button" onClick={() => { setIntro(false); onClose?.(); }}>以后再说</button><button type="button" disabled={!canAdd || busy || refreshRequired} onClick={() => begin({ kind: "add" })}>创建通行密钥</button></div>
    </AppModal> : !pending && (onClose ? <AppModal title="通行密钥" onClose={onClose} className="pk-reference-modal" size="lg">{content}</AppModal> : content)}
    {pending && <AppModal className="pk-reference-modal" size="lg" title={actionLabel} desc={pending.kind === "delete" ? `删除「${pending.key.name}」将退出相关登录及来源不明的旧登录，可能需要重新登录。仍可用密码登录。` : domainChanged ? "更换域名后需重新添加密钥。输入当前密码确认保存。" : "输入当前密码以继续。"} onClose={closeVerification} closeDisabled={busy}>
      <form onSubmit={confirmAction} className="flex flex-col gap-4">
        {pending.kind === "add" && <label className="flex flex-col gap-2 text-sm">密钥名称（选填）<input className="field w-full" value={name} maxLength={64} onChange={e => setName(e.target.value)} placeholder="如 iCloud、Bitwarden" disabled={busy} /></label>}
        <label className="flex flex-col gap-2 text-sm">当前密码<input className="field w-full" type="password" required autoComplete="current-password" data-autofocus autoFocus value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
        {totp && <label className="flex flex-col gap-2 text-sm">二次验证码或备用码<input className="field w-full" required autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label>}
        {verificationError && <p role="alert" className="text-sm text-up">{verificationError}</p>}
        <div className="dialog-actions"><button type="button" className="dialog-btn dialog-btn-ghost" disabled={busy} onClick={closeVerification}>取消</button><button type="submit" className={`dialog-btn ${pending.kind === "delete" ? "dialog-btn-danger" : "dialog-btn-neutral"}`} disabled={busy || !password || (totp && !code.trim())}>{busy ? "处理中…" : actionLabel}</button></div>
      </form>
    </AppModal>}
  </>;
}
