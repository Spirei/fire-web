"use client";

import { useEffect, useRef, useState } from "react";
import AppModal from "@/components/AppModal";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import type { AppConnectionBrand } from "@/lib/appConnectionBrand";
import { appAuthorizationDuration } from "@/lib/appDeviceTime";
import { parseAppDevices, type AppDevice } from "@/lib/appConnectionChecks";
import { readLimitedResponseJson } from "@/lib/requestBody";
import { SubNavIcon } from "@/components/SettingsHeader";
import styles from "./AppDeviceList.module.css";

type Device = AppDevice;
function DeviceTime({ value }: { value: number }) {
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return <>—</>;
  return <time dateTime={date.toISOString()}>{date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}

export default function AppDeviceList({ brand, onAppearance, compact = false }: { brand: AppConnectionBrand; onAppearance?: () => void; compact?: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [now, setNow] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
    setLoading(true); setError(""); setLoadError(false);
    fetch("/api/v1/auth/devices", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal }).then(async res => {
      const body = await readLimitedResponseJson<any>(res, 64 * 1024);
      const devices = parseAppDevices(body?.data?.devices);
      if (!res.ok || body?.code !== 0 || !devices) throw new Error(res.status === 401 ? "登录已失效，请重新登录" : "读取授权失败，请重试");
      if (!controller.signal.aborted) setDevices(devices);
    }).catch(e => {
      if (!controller.signal.aborted || timedOut) { setError(timedOut ? "读取超时，请重试" : e instanceof Error ? e.message : "读取授权失败"); setLoadError(true); }
    }).finally(() => { clearTimeout(timer); if (!controller.signal.aborted || timedOut) setLoading(false); });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [revision]);

  const hasDevices = devices.length > 0;
  useEffect(() => {
    if (!hasDevices) return;
    const update = () => setNow(Date.now());
    const onVisible = () => { if (document.visibilityState === "visible") update(); };
    update();
    const timer = setInterval(onVisible, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [hasDevices]);

  async function revoke() {
    if (inFlight.current || !target) return;
    const device = target;
    const controller = new AbortController(); mutation.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    inFlight.current = true; setBusy(true); setRevokeError("");
    try {
      const res = await fetch("/api/v1/auth/devices", { method: "DELETE", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id }), signal: controller.signal });
      const body = await readLimitedResponseJson<any>(res, 8192);
      if (!res.ok || body?.code !== 0 || body.data?.revoked !== true) throw new Error("未能确认断开结果，请重新读取设备状态后重试");
      if (!controller.signal.aborted) { setDevices(current => current.filter(d => d.id !== device.id)); setTarget(null); }
    } catch (e) {
      if (!controller.signal.aborted || timedOut) {
        setRevokeError(timedOut ? "请求超时，断开结果待确认；请关闭此框核对已重新读取的设备列表" : e instanceof Error ? e.message : "断开失败，请重试");
        setRevision(value => value + 1);
      }
    }
    finally { clearTimeout(timer); inFlight.current = false; if (!controller.signal.aborted || timedOut) setBusy(false); }
  }

  return <div className={`${styles.manager}${compact ? ` ${styles.compact}` : ""}`} aria-busy={loading}>
    {loading ? <div className={styles.skeleton} role="status" aria-label="正在读取授权">
      <div className={styles.skeletonHeader} aria-hidden="true"><i /><div><i /><i /></div></div>
      <div className={styles.skeletonDetails} aria-hidden="true"><i /><i /></div>
      <div className={styles.skeletonFooter} aria-hidden="true"><i /><i /></div>
    </div> : loadError ? <div className={styles.state}>
      <span className={styles.stateIcon} aria-hidden="true"><SubNavIcon name="authorizations" size={36} className={styles.emptyIcon} /></span>
      <p role="alert" className={styles.error}>{error}</p><button type="button" className={`dialog-btn dialog-btn-ghost ${styles.retry}`} onClick={() => setRevision(value => value + 1)}>重试</button>
    </div> : devices.length === 0 ? <div className={`${styles.state} ${styles.empty}`}>
      <span className={styles.stateIcon} aria-hidden="true"><SubNavIcon name="authorizations" size={36} className={styles.emptyIcon} /></span><p>暂无授权设备</p>
    </div> : <ul className={styles.list} aria-label="已授权设备">
      {devices.map(d => <li key={d.id} className={styles.card}>
        <div className={styles.header}>
          <div className={styles.icon}><AppConnectionIcon src={brand.appIcon} small /></div>
          <div className={styles.name}>
            <h3>{d.name}</h3>
            <div className={styles.subtitle}><span className={styles.appName} title={brand.appName}>{brand.appName}</span><span className={styles.permission} aria-label={d.scope.split(" ").includes("portfolio.write") ? "查看与管理投资数据" : "查看投资数据"} title={d.scope.split(" ").includes("portfolio.write") ? "查看与管理投资数据" : "查看投资数据"}>{d.scope.split(" ").includes("portfolio.write") ? "可管理" : "只读"}</span>{d.scope.split(" ").includes("profile.write") && <span className={styles.permission} title="允许修改昵称、用户名、邮箱和头像">资料编辑</span>}{d.scope.split(" ").includes("feed.read") && <span className={styles.permission} title={d.scope.split(" ").includes("feed.write") ? "查看与管理个人动态" : "查看个人动态"}>动态{d.scope.split(" ").includes("feed.write") ? "管理" : "只读"}</span>}{d.scope.split(" ").includes("resources.read") && <span className={styles.permission} title={d.scope.split(" ").includes("resources.write") ? "查看、上传和永久删除个人文件" : "查看和下载个人文件"}>资源库{d.scope.split(" ").includes("resources.write") ? "管理" : "只读"}</span>}</div>
          </div>
        </div>
        <dl className={styles.details}>
          <div><dt>授权时间</dt><dd><DeviceTime value={d.createdAt} /></dd></div>
          <div><dt>授权时长</dt><dd>{now ? appAuthorizationDuration(d.createdAt, now) : "—"}</dd></div>
        </dl>
        <div className={styles.footer}>
          <dl className={styles.lastUsed}><dt>最近使用</dt><dd><DeviceTime value={d.lastUsedAt} /></dd></dl>
          <button type="button" className={`dialog-btn dialog-btn-danger ${styles.disconnect}`} aria-label={`断开 ${d.name} 的连接`} onClick={() => { setTarget(d); setRevokeError(""); }}>断开连接</button>
        </div>
      </li>)}
    </ul>}
    {onAppearance && <div className={styles.appearanceGroup}><button type="button" className={styles.appearance} onClick={onAppearance}>
      <span className={styles.appearanceLabel}><SubNavIcon name="image" size={18} className={styles.appearanceIcon} /><span>授权页外观</span></span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </button></div>}
    {target && <AppModal title="断开连接？" desc={`撤销「${target.name}」的访问权限。`} onClose={() => { if (!inFlight.current) setTarget(null); }} closeDisabled={busy} priority>
      {revokeError && <p role="alert" className={styles.error}>{revokeError}</p>}
      <div className="mt-5 flex justify-end gap-2.5">
        <button type="button" disabled={busy} onClick={() => setTarget(null)} className="dialog-btn dialog-btn-ghost">取消</button>
        <button type="button" disabled={busy} onClick={() => void revoke()} className="dialog-btn dialog-btn-danger">{busy ? "正在断开…" : "断开连接"}</button>
      </div>
    </AppModal>}
  </div>;
}
