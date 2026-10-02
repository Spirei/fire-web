"use client";

import { useEffect, useId, useRef, useState } from "react";
import VisibilityIcon from "@/components/VisibilityIcon";
import { readXueqiuCookie, type XueqiuCookieDraft } from "@/lib/xueqiuCookieClient";
import { copyTextFrom } from "@/lib/clipboard";
import { showToast } from "@/lib/toast";

export default function XueqiuCookieInput({ draft, configured, editing, disabled = false, onChange }: {
  draft: XueqiuCookieDraft; configured: boolean; editing: boolean; disabled?: boolean;
  onChange: (draft: XueqiuCookieDraft) => void;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const actionRef = useRef<"reveal" | "copy" | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearing = draft.dirty && !draft.value.trim() && configured;
  const canRead = draft.dirty ? Boolean(draft.value.trim()) : configured;
  const value = draft.dirty ? draft.value : visible ? preview : "";

  function stopRead() {
    generation.current += 1;
    request.current?.abort(); request.current = null;
    actionRef.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  function conceal() {
    stopRead(); setVisible(false); setPreview(""); setBusy(false);
  }
  useEffect(() => { conceal(); setError(""); }, [editing, disabled, configured]);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) conceal(); };
    // Clipboard permission/focus changes may blur the window; an explicit copy can finish without displaying the secret.
    const onBlur = () => { if (actionRef.current === "copy") { setVisible(false); setPreview(""); } else conceal(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      stopRead();
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  async function perform(action: "reveal" | "copy") {
    if (disabled || request.current || !canRead) return;
    if (action === "reveal" && visible) { conceal(); return; }
    const controller = new AbortController(); request.current = controller;
    actionRef.current = action;
    const current = ++generation.current;
    setBusy(true); setError("");
    timer.current = setTimeout(() => controller.abort(), 10_000);
    try {
      const load = async () => draft.dirty ? draft.value : preview || await readXueqiuCookie(controller.signal);
      if (action === "reveal") {
        const cookie = await load();
        if (current !== generation.current) return;
        if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
        if (!draft.dirty) setPreview(cookie);
        setVisible(true);
      } else {
        const copied = await copyTextFrom(load, controller.signal);
        if (current !== generation.current) return;
        if (!copied) throw new Error("复制失败，请显示后手动复制");
        showToast("Cookie 已复制");
      }
    } catch (err) {
      if (current !== generation.current) return;
      setError(controller.signal.aborted ? action === "copy" ? "复制超时，请重试" : "Cookie 读取超时，请重试" : err instanceof Error && ["登录已过期，请重新登录", "需要管理员权限", "操作频繁，请稍后重试", "未找到可读取的 Cookie，请重新配置", "复制失败，请显示后手动复制"].includes(err.message) ? err.message : "Cookie 读取失败，请重试");
    } finally {
      if (current === generation.current) { stopRead(); setBusy(false); }
    }
  }

  return <div className="xueqiu-cookie-field">
    <div className="xueqiu-cookie-control" data-editing={editing}>
      <input id={id} className="sw-row-input" aria-label="雪球 Cookie" type={visible ? "text" : "password"} autoComplete="off" autoCapitalize="off" autoCorrect="off" data-bwignore="true" spellCheck={false} maxLength={16384}
        readOnly={!editing} disabled={disabled || busy} value={value}
        placeholder={clearing ? "保存后清除 Cookie" : configured ? editing ? "输入新 Cookie" : "已配置" : "xq_a_token=…; u=…; …"}
        onKeyDown={event => { if (event.key === "Escape" && visible) { event.preventDefault(); event.stopPropagation(); conceal(); } }}
        onChange={event => { stopRead(); setPreview(""); setError(""); onChange({ value: event.target.value, dirty: true }); }} />
      <div className="xueqiu-cookie-actions">
        <button type="button" data-capsule="off" disabled={disabled || busy || !canRead} aria-label={visible ? "隐藏雪球 Cookie" : "显示雪球 Cookie"} title={visible ? "隐藏 Cookie" : "显示 Cookie"} aria-controls={id} aria-pressed={visible} aria-busy={busy && actionRef.current === "reveal"}
          onMouseDown={event => event.preventDefault()} onClick={() => void perform("reveal")}>{busy && actionRef.current === "reveal" ? <CookieActionSpinner /> : <VisibilityIcon hidden={visible} />}</button>
        <button type="button" data-capsule="off" disabled={disabled || busy || !canRead} aria-label="复制雪球 Cookie" aria-busy={busy && actionRef.current === "copy"} title="复制 Cookie" onMouseDown={event => event.preventDefault()} onClick={() => void perform("copy")}>
          {busy && actionRef.current === "copy" ? <CookieActionSpinner /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>}
        </button>
        {editing && <button type="button" data-capsule="off" disabled={disabled || busy || (!draft.dirty && !configured)} aria-label={clearing ? "撤销清除雪球 Cookie" : "清空雪球 Cookie"} title={clearing ? "撤销清除" : "清空 Cookie"}
          onMouseDown={event => event.preventDefault()} onClick={() => { conceal(); setError(""); onChange({ value: "", dirty: !clearing }); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{clearing ? <><path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6" /></> : <path d="M6 6l12 12M6 18 18 6" />}</svg>
        </button>}
      </div>
    </div>
    {clearing && <small className="xueqiu-cookie-pending" role="status">待清除 · 保存后生效</small>}
    {error && <small className="xueqiu-cookie-error" role="alert">{error}</small>}
  </div>;
}

function CookieActionSpinner() {
  return <svg className="xueqiu-cookie-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" opacity=".2" /><path d="M12 4a8 8 0 0 1 8 8" /></svg>;
}
