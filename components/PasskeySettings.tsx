"use client";

import PasswordInput from "@/components/PasswordInput";
import { useEffect, useRef, useState, type FormEvent } from "react";
import AppModal from "@/components/AppModal";
import { startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { SubNavIcon } from "@/components/SettingsHeader";
import { passkeyError, passkeyRequest, passkeyRead, PasskeyRequestError } from "@/lib/passkeyClient";
import { parsePasskeyConfig, isPublicPasskeyConfig, type PublicPasskeyConfig } from "@/lib/passkeyConfig";
import { appPrompt } from "@/lib/appDialog";
import { createPasskeySettingsData, type PasskeySettingsData } from "@/lib/passkeySettingsData";

type Config = PublicPasskeyConfig;
type Key = { id: string; name: string; rpID: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };
type PendingAction = { kind: "save"; config: Config } | { kind: "add" } | { kind: "delete"; key: Key };
const normalizeDraft = (value: Config): Config => ({ ...value, origin: value.origin.trim().replace(/\/$/, ""), name: value.name.trim() });
export default function PasskeySettings({ admin, onClose, mode = "keys", dataSource }: { admin: boolean; onClose?: () => void; mode?: "keys" | "config"; dataSource?: PasskeySettingsData }) {
  const [source] = useState(() => dataSource ?? createPasskeySettingsData());
  const [initial] = useState(() => source.peek());
  const [showHelp, setShowHelp] = useState(false);
  const [intro, setIntro] = useState(false);
  const [flowDirection, setFlowDirection] = useState<"forward" | "back">("forward");
  const [config, setConfig] = useState<Config | null>(initial?.config ?? null);
  const [draft, setDraft] = useState<Config>(initial?.config ?? { enabled: false, origin: "", name: "Fire", revision: "" });
  const [keys, setKeys] = useState<Key[]>(initial?.keys ?? []);
  const [totp, setTotp] = useState(initial?.totpEnabled ?? false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!initial);
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
      const { config: next, keys: nextKeys, totpEnabled } = await source.read(keepDraft);
      if (controller.signal.aborted) return;
      setKeys(nextKeys); setTotp(totpEnabled);
      setConfig(next); if (!keepDraft) setDraft(next);
      setRefreshRequired(false);
      if (keepDraft) setMessage("已刷新，请检查设置和密钥后再操作");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof PasskeyRequestError && error.status === 401) { window.location.assign("/login"); return; }
        setMessage(passkeyError(error));
        if (initial) setRefreshRequired(true);
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
      if (!dataSource) source.invalidate();
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
    if (loading || lock.current || pending || refreshRequired) return;
    setFlowDirection("forward");
    setPassword(""); setCode(""); setName(""); setVerificationError(""); setMessage(""); setPending(action);
  }
  function closeVerification() {
    if (lock.current) return;
    setFlowDirection("back");
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
    source.invalidate();
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
      setFlowDirection("back"); setPending(null); setName(""); setIntro(false);
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
    if (loading || lock.current || pending || refreshRequired) return;
    const value = await appPrompt("填写便于识别的名称", { title: "重命名", placeholder: key.name });
    const nextName = value?.trim().slice(0, 64);
    if (!nextName || nextName === key.name || lock.current) return;
    source.invalidate();
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
    <p className="pk-intro">{mode === "config" ? "设置此部署用于通行密钥登录的 HTTPS 地址和站点名称。" : "使用安全又方便的通行密钥来替代密码。"}{mode === "keys" && <button type="button" className="pk-text-link" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>详细了解</button>}</p>
    {showHelp && <div className="pk-help"><p>通过面容、指纹或设备密码登录，无需输入网站密码。</p><p>可保存在 iCloud 钥匙串、Bitwarden、1Password 等密码管理器中。Fire 不会获取你的面容或指纹。</p></div>}
    {message && <p role="status" className="rounded-xl border border-edge bg-bg-gray p-3 text-sm text-ink">{message}</p>}
    {refreshRequired && <button type="button" className="btn btn-line btn-sm self-start disabled:opacity-50" disabled={loading || busy} onClick={() => void load(true)}>刷新确认</button>}
    {!config && loading ? <div className="pk-loading-placeholder" role="status" aria-label="正在读取通行密钥"><i /><i /></div> : !config ? <button className="btn btn-line btn-sm self-start" type="button" onClick={() => void load()}>重试</button> : <>
    {admin && mode === "config" && <section className="rounded-2xl border border-edge p-4 sm:p-5">
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
    {mode === "keys" && <section>
      <button type="button" className="pk-create-row disabled:opacity-50" disabled={loading || busy || !!pending || refreshRequired} onClick={() => { setFlowDirection("forward"); setIntro(true); }}>创建通行密钥</button>
      <ul className="divide-y divide-edge">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0"><p className="break-all font-medium">{key.name}</p><p className="mt-1 break-all text-xs text-muted">{key.rpID} · {currentRPID && key.rpID !== currentRPID ? "旧域名密钥" : key.backedUp ? "已同步备份" : "设备或密码管理器保管"}</p><p className="mt-1 text-xs text-muted">{key.lastUsedAt ? `最近使用：${new Date(key.lastUsedAt).toLocaleString()}` : `添加于：${new Date(key.createdAt).toLocaleString()}`}</p></div>
        <div className="flex gap-2"><button type="button" className="btn btn-line btn-sm disabled:opacity-50" disabled={busy || !!pending || refreshRequired} onClick={() => void rename(key)}>重命名</button><button type="button" className="btn btn-line btn-sm !text-up disabled:opacity-50" disabled={busy || !!pending || refreshRequired} onClick={() => begin({ kind: "delete", key })}>删除</button></div>
      </li>)}</ul>
      {!config.enabled ? <p className="mt-4 text-xs text-muted">{admin ? "启用并保存登录设置后，即可添加。" : "管理员启用后即可添加。"}</p> : origin !== config.origin ? <p className="mt-4 text-xs text-muted">请访问 <a className="break-all underline" href={config.origin}>{config.origin}</a> 添加。</p> : !supported ? <p className="mt-4 text-xs text-muted">请使用支持通行密钥的浏览器。</p> : keys.length >= 20 ? <p className="mt-4 text-xs text-muted">已达 20 个，请先删除不用的密钥。</p> : null}
    </section>}
    </>}
  </div>;
  const renderIntroContent = (requestClose: () => void) => <div className={`pk-flow-view is-${flowDirection}`} key="intro">
    <button type="button" className="pk-back" aria-label="返回" onClick={() => { setFlowDirection("back"); setIntro(false); }}>‹</button>
    <img className="pk-security-art" src="/uploads/feature/passkey/%E9%80%9A%E8%A1%8C%E5%AF%86%E9%92%A5PASSKEY.png" alt="通行密钥保护登录安全" />
    <div className="pk-benefits"><p><SubNavIcon name="passkeys"/><span>使用面容、指纹或设备密码登录，就像解锁设备一样。</span></p><p><SubNavIcon name="account"/><span>你的生物识别信息始终留在设备上，不会分享给 Fire。</span></p></div>
    {!canAdd && <p className="pk-availability">{!config?.enabled ? (admin ? "请先启用网站登录配置。" : "请等待管理员启用通行密钥。") : origin !== config.origin ? <>请访问 <a href={config.origin}>{config.origin}</a> 创建。</> : !supported ? "请在 HTTPS 下使用支持通行密钥的浏览器。" : "已达 20 个密钥，请先移除不再使用的密钥。"}</p>}
    <div className="pk-intro-actions"><button type="button" onClick={requestClose}>以后再说</button><button type="button" disabled={!canAdd || busy || refreshRequired} onClick={() => begin({ kind: "add" })}>创建通行密钥</button></div>
  </div>;
  const verificationContent = pending && <div className={`pk-flow-view is-${flowDirection}`} key="verify">
    <form onSubmit={confirmAction} className="pk-verify-form">
        <div className="pk-account-row"><span className="pk-account-mark"><SubNavIcon name="account" /></span><span><b>Fire 账号</b><small>安全验证</small></span></div>
        {pending.kind === "add" && <label className="pk-field"><span>通行密钥名称（选填）</span><input value={name} maxLength={64} onChange={e => setName(e.target.value)} placeholder="例如：iCloud 或 Bitwarden" disabled={busy} /></label>}
        <label className="pk-field"><span>当前密码</span><PasswordInput type="password" required autoComplete="current-password" data-autofocus autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder="输入当前密码" disabled={busy} /></label>
        {totp && <label className="pk-field"><span>二次验证码或备用码</span><input required autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="6 位验证码或备用码" disabled={busy} /></label>}
        {verificationError && <p role="alert" className="text-sm text-up">{verificationError}</p>}
        <div className="dialog-actions"><button type="button" className="dialog-btn dialog-btn-ghost" disabled={busy} onClick={closeVerification}>取消</button><button type="submit" className={`dialog-btn ${pending.kind === "delete" ? "dialog-btn-danger" : "dialog-btn-neutral"}`} disabled={busy || !password || (totp && !code.trim())}>{busy ? "处理中…" : actionLabel}</button></div>
    </form>
  </div>;
  if (!onClose) return <>{content}{pending && <AppModal className="pk-reference-modal pk-verify-modal" size="lg" title={actionLabel} desc={pending.kind === "delete" ? `删除「${pending.key.name}」后，相关设备需要重新登录。` : domainChanged ? "更换域名后需重新添加通行密钥。请验证当前账号。" : "为了保护账号安全，请先验证当前账号。"} onClose={closeVerification} closeDisabled={busy}>{verificationContent}</AppModal>}</>;
  const modalTitle = pending ? actionLabel : intro ? "下次免密登录" : mode === "config" ? "通行密钥登录" : "通行密钥";
  const modalDesc = pending ? (pending.kind === "delete" ? `删除「${pending.key.name}」后，相关设备需要重新登录。` : domainChanged ? "更换域名后需重新添加通行密钥。请验证当前账号。" : "为了保护账号安全，请先验证当前账号。") : undefined;
  return <AppModal
    title={modalTitle}
    desc={modalDesc}
    onClose={onClose}
    closeDisabled={busy}
    className={`pk-reference-modal${intro ? " pk-intro-modal" : ""}${pending ? " pk-verify-modal" : ""}`}
    size="lg"
  >
    {(requestClose) => pending ? verificationContent : intro ? renderIntroContent(requestClose) : <div className={`pk-flow-view is-${flowDirection}`} key="list">{content}</div>}
  </AppModal>;
}
