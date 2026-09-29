"use client";

import { useEffect, useRef, useState } from "react";
import AppModal from "@/components/AppModal";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import type { AppConnectionBrand } from "@/lib/appConnectionBrand";
import { SubNavIcon } from "@/components/SettingsHeader";

type Device = { id: string; name: string; scope: string; createdAt: number; lastUsedAt: number };
function DeviceTime({ value }: { value: number }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}

export default function AppDeviceList({ brand }: { brand: AppConnectionBrand }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setLoadError(false);
    fetch("/api/v1/auth/devices", { cache: "no-store", credentials: "same-origin", signal: controller.signal }).then(async res => {
      const body = await res.json();
      if (!res.ok || body.code !== 0 || !Array.isArray(body.data?.devices)) throw new Error(body.message || "读取授权失败");
      if (!controller.signal.aborted) setDevices(body.data.devices);
    }).catch(e => {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : "读取授权失败"); setLoadError(true); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function revoke() {
    if (inFlight.current || !target) return;
    const device = target;
    const controller = new AbortController(); mutation.current = controller;
    inFlight.current = true; setBusy(true); setRevokeError("");
    try {
      const res = await fetch("/api/v1/auth/devices", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id }), signal: controller.signal });
      const body = await res.json();
      if (!res.ok || body.code !== 0) throw new Error(body.message || "撤销失败，请重试");
      if (!controller.signal.aborted) { setDevices(current => current.filter(d => d.id !== device.id)); setTarget(null); }
    } catch (e) { if (!controller.signal.aborted) setRevokeError(e instanceof Error ? e.message : "撤销失败，请重试"); }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  }

  return <div className="app-device-manager" aria-busy={loading}>
    {loading ? <div className="app-devices-loading" role="status"><span className="app-connection-spinner" aria-hidden="true" />正在读取授权…</div> : loadError ? <div className="app-devices-empty">
      <SubNavIcon name="authorizations" className="app-devices-empty-icon" /><p role="alert">{error}</p><button type="button" className="app-connection-button" onClick={() => setRevision(value => value + 1)}>重试</button>
    </div> : devices.length === 0 ? <div className="app-devices-empty">
      <SubNavIcon name="authorizations" className="app-devices-empty-icon" /><h2>暂无已授权的 App</h2>
    </div> : <ul className="app-device-list">
      {devices.map(d => <li key={d.id} className="app-device-card">
        <div className="app-device-card-header"><AppConnectionIcon src={brand.appIcon} small /><div className="app-device-name"><h3>{d.name}</h3><span>{brand.appName}</span></div><button type="button" className="app-device-revoke" onClick={() => { setTarget(d); setRevokeError(""); }}>撤销授权</button></div>
        <dl className="app-device-details">
          <div><dt>授权权限</dt><dd>{d.scope.split(" ").includes("portfolio.write") ? "查看与管理投资数据" : "查看投资数据"}</dd></div>
          <div><dt>授权时间</dt><dd><DeviceTime value={d.createdAt} /></dd></div>
          <div><dt>最近使用</dt><dd><DeviceTime value={d.lastUsedAt} /></dd></div>
        </dl>
      </li>)}
    </ul>}
    {target && <AppModal title="撤销授权？" desc={`「${target.name}」将无法继续访问此账户，需要重新授权才能连接。`} onClose={() => { if (!inFlight.current) setTarget(null); }} closeDisabled={busy} priority>
      {revokeError && <p role="alert" className="app-connection-error">{revokeError}</p>}
      <div className="mt-5 flex justify-end gap-2.5">
        <button type="button" disabled={busy} onClick={() => setTarget(null)} className="dialog-btn dialog-btn-ghost">取消</button>
        <button type="button" disabled={busy} onClick={() => void revoke()} className="dialog-btn dialog-btn-danger">{busy ? "正在撤销…" : "撤销授权"}</button>
      </div>
    </AppModal>}
  </div>;
}
