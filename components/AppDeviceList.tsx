"use client";
import { useEffect, useState } from "react";
type Device = { id: string; name: string; createdAt: number; lastUsedAt: number };
export default function AppDeviceList() {
  const [devices, setDevices] = useState<Device[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/auth/devices", { cache: "no-store", signal: controller.signal }).then(async res => {
      const body = await res.json(); if (!res.ok || body.code !== 0) throw new Error(body.message || "读取失败");
      setDevices(body.data.devices);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || "读取失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function revoke(device: Device) {
    if (busy || !window.confirm(`断开「${device.name}」？`)) return;
    setBusy(device.id); setError("");
    try {
      const res = await fetch("/api/v1/auth/devices", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id }) });
      const body = await res.json(); if (!res.ok || body.code !== 0) throw new Error(body.message || "断开失败");
      setDevices(current => current.filter(d => d.id !== device.id));
    } catch (e) { setError(e instanceof Error ? e.message : "断开失败"); } finally { setBusy(""); }
  }
  return <div className="space-y-4">
    {loading && <p className="text-muted">正在读取…</p>}
    {error && <p role="alert" className="text-red-500">{error}</p>}
    {!loading && !error && !devices.length && <p className="text-muted">暂无已连接设备</p>}
    {devices.map(d => <div key={d.id} className="flex items-center gap-4 rounded-2xl border border-edge bg-white p-4">
      <div className="min-w-0 flex-1"><strong className="break-words">{d.name}</strong><p className="mt-1 text-xs text-muted">上次连接：{new Date(d.lastUsedAt).toLocaleString("zh-CN")}</p></div>
      <button disabled={!!busy} onClick={() => void revoke(d)} className="rounded-full border border-edge-strong px-4 py-2 text-red-500">{busy === d.id ? "正在断开…" : "断开"}</button>
    </div>)}
  </div>;
}
