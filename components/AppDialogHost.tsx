"use client";

import { useEffect, useState } from "react";
import AppModal from "@/components/AppModal";
import { APP_DIALOG_EVENT, type AppDialogRequest } from "@/lib/appDialog";

export default function AppDialogHost() {
  const [current, setCurrent] = useState<AppDialogRequest | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<AppDialogRequest>).detail;
      setDraft("");
      setCurrent(request);
    };
    window.addEventListener(APP_DIALOG_EVENT, open);
    return () => window.removeEventListener(APP_DIALOG_EVENT, open);
  }, []);

  if (!current) return null;
  const finish = (value: boolean | string | null) => { current.resolve(value); setCurrent(null); };
  return <AppModal title={current.title} desc={current.message} onClose={() => finish(current.kind === "confirm" ? false : null)} size="sm">
    {current.kind === "prompt" && <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) finish(draft.trim()); }} placeholder={current.placeholder} className="field w-full" />}
    <div className="dialog-actions">
      {/* 底部按钮统一走 globals.css 的胶囊配方：ghost 取消 / neutral 确认 / danger 删除。
          此前取消挂的是并不存在的 btn-secondary（只剩 .btn 布局，没有底色与文字色），深色模式下几乎看不见。 */}
      {current.kind !== "alert" && <button type="button" className="dialog-btn dialog-btn-ghost" onClick={() => finish(current.kind === "confirm" ? false : null)}>取消</button>}
      <button type="button" className={current.danger ? "dialog-btn dialog-btn-danger" : "dialog-btn dialog-btn-neutral"} disabled={current.kind === "prompt" && !draft.trim()} onClick={() => finish(current.kind === "prompt" ? draft.trim() : true)}>{current.kind === "alert" ? "知道了" : "确认"}</button>
    </div>
  </AppModal>;
}
