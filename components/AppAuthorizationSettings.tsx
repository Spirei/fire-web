"use client";

import { useEffect, useRef, useState } from "react";
import type { SiteSettings } from "@/lib/types";
import { appConnectionBrand, isConnectionIconUrl } from "@/lib/appConnectionBrand";
import { appConnectionSettingsPatch, normalizeAppConnectionOrigin, runAppConnectionChecks, type AppConnectionFields, type ConnectionCheck } from "@/lib/appConnectionChecks";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import AppDeviceList from "@/components/AppDeviceList";
import { readLimitedResponseJson } from "@/lib/requestBody";
import styles from "./AppAuthorizationSettings.module.css";

type ConnectionFields = AppConnectionFields;
type Props = {
  site: SiteSettings;
  admin: boolean;
  onSave: (fields: Partial<ConnectionFields>, signal: AbortSignal) => Promise<boolean>;
};
const fieldsOf = (site: SiteSettings): ConnectionFields => ({ domain: site.domain, appDisplayName: site.appDisplayName, appDisplayIcon: site.appDisplayIcon });

export default function AppAuthorizationSettings({ site, admin, onSave }: Props) {
  const [draft, setDraft] = useState(() => fieldsOf(site));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checks, setChecks] = useState<ConnectionCheck[] | null>(null);
  const [browserOrigin, setBrowserOrigin] = useState("");
  const operation = useRef(false);
  const baseline = useRef(fieldsOf(site));
  const diagnostic = useRef<AbortController | null>(null);
  const upload = useRef<AbortController | null>(null);
  const savingRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setBrowserOrigin(window.location.origin); return () => { diagnostic.current?.abort(); upload.current?.abort(); savingRequest.current?.abort(); }; }, []);
  useEffect(() => { if (!editing) setDraft(fieldsOf(site)); }, [site.domain, site.appDisplayName, site.appDisplayIcon, editing]);
  useEffect(() => { diagnostic.current?.abort(); diagnostic.current = null; setChecks(null); setTesting(false); }, [site.domain]);
  const brand = appConnectionBrand(site);
  const development = process.env.NODE_ENV !== "production";
  const connectionOrigin = normalizeAppConnectionOrigin(site.domain, development);
  const mismatch = Boolean(connectionOrigin && browserOrigin && connectionOrigin !== browserOrigin);
  const busy = saving || uploading;
  function change(key: keyof ConnectionFields, value: string) { setDraft(current => ({ ...current, [key]: value })); setError(""); setNotice(""); }

  async function save() {
    if (operation.current) return;
    let fields: Partial<ConnectionFields>;
    try { fields = appConnectionSettingsPatch(draft, baseline.current, development); }
    catch (err) { setError(err instanceof Error ? err.message : "配置无效"); return; }
    if (fields.appDisplayIcon !== undefined && !isConnectionIconUrl(fields.appDisplayIcon)) { setError("图标须为站内路径或 http(s) 图片地址。"); return; }
    if (!Object.keys(fields).length) { setEditing(false); setNotice("配置未变更"); return; }
    operation.current = true; setSaving(true); setError(""); setNotice("");
    const controller = new AbortController(); savingRequest.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const ok = await onSave(fields, controller.signal);
      if (controller.signal.aborted && !timedOut) return;
      if (ok && !controller.signal.aborted) { setEditing(false); setNotice("配置已保存"); }
      else setError("未能确认配置已保存，请刷新核对后重试。");
    } catch { if (!controller.signal.aborted || timedOut) setError("未能确认配置已保存，请刷新核对后重试。"); }
    finally { clearTimeout(timer); operation.current = false; if (!controller.signal.aborted || timedOut) setSaving(false); }
  }

  async function uploadIcon(file: File) {
    if (operation.current) return;
    operation.current = true; setUploading(true); setError(""); setNotice("");
    const controller = new AbortController(); upload.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const form = new FormData(); form.set("kind", "ico"); form.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", credentials: "same-origin", redirect: "error", body: form, signal: controller.signal });
      const body = await readLimitedResponseJson<any>(res, 8192);
      if (!res.ok || typeof body?.url !== "string" || !body.url.startsWith("/uploads/ico/") || !isConnectionIconUrl(body.url)) throw new Error("上传失败，请检查图片格式、大小和登录状态");
      if (controller.signal.aborted) return;
      setDraft(current => ({ ...current, appDisplayIcon: body.url }));
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "上传失败"); else setError("上传超时，请重试。"); }
    finally { clearTimeout(timer); operation.current = false; setUploading(false); }
  }

  async function testConnection() {
    if (diagnostic.current) return;
    const controller = new AbortController(); diagnostic.current = controller;
    setTesting(true); setChecks(null);
    const timer = setTimeout(() => controller.abort(), 10_000);
    try { const result = await runAppConnectionChecks(controller.signal); if (!controller.signal.aborted) setChecks(result); }
    catch { if (diagnostic.current === controller) setChecks([{ name: "连接测试", ok: false, message: "测试超时或已取消，请重试" }]); }
    finally { clearTimeout(timer); if (diagnostic.current === controller) { setTesting(false); diagnostic.current = null; } }
  }

  return <div className={styles.root}>
    <section className={styles.section} aria-labelledby="app-connection-settings-title">
      <div className={styles.heading}><div><h3 id="app-connection-settings-title">连接配置</h3><p>Alcor Api · 账号与投资数据共用</p></div>{admin && !editing && <button type="button" className="dialog-btn dialog-btn-ghost" onClick={() => { baseline.current = fieldsOf(site); setDraft(baseline.current); setEditing(true); setError(""); setNotice(""); }}>编辑</button>}</div>
      {editing && admin ? <fieldset disabled={busy} className={styles.form}>
        <label>连接地址<input aria-label="Alcor Api 连接地址" value={draft.domain} maxLength={255} inputMode="url" autoComplete="off" placeholder="https://alcor.example.com:18520" onChange={e => change("domain", e.target.value)} /></label>
        <p className={styles.note}>与站点域名共用，修改会影响网页授权与站点链接。部署设置 FIRE_APP_ORIGIN 时，以部署地址为准。</p>
        <label>App 显示名称<input value={draft.appDisplayName} maxLength={80} placeholder={appConnectionBrand({ ...site, appDisplayName: "" }).appName} onChange={e => change("appDisplayName", e.target.value)} /></label>
        <div className={styles.iconRow}><AppConnectionIcon src={draft.appDisplayIcon || appConnectionBrand({ ...site, appDisplayIcon: "" }).appIcon} small /><div><b>授权图标</b><span>留空使用默认图标</span></div><button type="button" className="dialog-btn dialog-btn-ghost" onClick={() => fileInput.current?.click()}>{uploading ? "上传中…" : "上传"}</button></div>
        <label className="sr-only" htmlFor="app-auth-icon-url">授权图标链接</label><input id="app-auth-icon-url" aria-label="授权图标链接" value={draft.appDisplayIcon} maxLength={2048} inputMode="url" placeholder="站内图片路径或 http(s) 地址" onChange={e => change("appDisplayIcon", e.target.value)} />
        {draft.appDisplayIcon && <button type="button" className={`dialog-btn dialog-btn-ghost ${styles.resetIcon}`} onClick={() => change("appDisplayIcon", "")}>恢复默认图标</button>}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,.svg,.ico" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadIcon(file); event.target.value = ""; }} />
        <div className={styles.actions}><button type="button" className="dialog-btn dialog-btn-ghost" onClick={() => { setEditing(false); setError(""); }}>取消</button><button type="button" className="dialog-btn dialog-btn-primary" onClick={() => void save()}>{saving ? "保存中…" : "保存配置"}</button></div>
      </fieldset> : <><div className={styles.brand}><AppConnectionIcon src={brand.appIcon} small /><div><b>{brand.appName}</b><span>{connectionOrigin || "尚未配置公网连接地址"}</span></div></div><p className={styles.note}>{admin ? "生产连接需要公网 HTTPS 地址；更改配置不会清除已有授权。" : "连接配置由站点管理员维护。你可以测试当前连接或断开自己的设备。"}</p></>}
      {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.note}>{notice}</p>}
    </section>
    <section className={styles.section} aria-labelledby="app-connection-check-title">
      <div className={styles.heading}><div><h3 id="app-connection-check-title">连接测试</h3><p>检查当前站点，不创建授权或改写资料</p></div><button type="button" className="dialog-btn dialog-btn-ghost" disabled={testing || busy} onClick={() => void testConnection()}>{testing ? "测试中…" : "测试连接"}</button></div>
      {mismatch && <p className={styles.note}>当前访问地址与配置地址不同，测试仅验证当前站点。请通过配置的 HTTPS 地址再检查正式连接。</p>}
      {checks && <ul className={styles.checks} aria-live="polite">{checks.map(check => <li key={check.name} data-ok={check.ok}><span aria-hidden="true">{check.ok ? "✓" : "!"}</span><div><b>{check.name}</b><small>{check.message}</small></div></li>)}</ul>}
    </section>
    <section className={styles.section} aria-labelledby="app-connected-devices-title"><div className={styles.heading}><div><h3 id="app-connected-devices-title">已连接设备</h3><p>断开后，访问与刷新令牌同时失效</p></div></div><AppDeviceList brand={brand} compact /></section>
  </div>;
}
