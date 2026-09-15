"use client";

import { useEffect, useState } from "react";
import AppModal from "@/components/AppModal";
import { APP_DIALOG_EVENT, type AppDialogRequest } from "@/lib/appDialog";

/**
 * 弹窗底部按钮：中性按钮沿用全站「白底 + 浅灰边框 + 深色文字」（深色模式对应的深灰底 + 白字），
 * danger（删除类）用实心红底白字。尺寸显式给足，避免只继承 .btn 的布局类而变成「一行小字」。
 */
const DIALOG_BUTTON_NEUTRAL =
  "btn h-10 px-5 text-sm border border-edge-strong bg-white text-ink-2 hover:bg-brand-hover dark:border-edge-strong dark:bg-[#1c1c1e] dark:text-white dark:hover:bg-[#26282e] disabled:opacity-50";
const DIALOG_BUTTON_DANGER =
  "btn h-10 px-5 text-sm border border-[#c34f4f] bg-[#c34f4f] text-white hover:border-[#ad4545] hover:bg-[#ad4545] disabled:opacity-50";

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
    <div className="mt-6 flex justify-end gap-2.5">
      {/* 底部操作按钮统一给足尺寸与底色：此前取消用了并不存在的 btn-secondary 类，
          只剩 .btn 的布局没有背景/文字色，深色模式下几乎看不清；danger 按钮同样缺内边距。 */}
      {current.kind !== "alert" && <button type="button" className={DIALOG_BUTTON_NEUTRAL} onClick={() => finish(current.kind === "confirm" ? false : null)}>取消</button>}
      <button type="button" className={current.danger ? DIALOG_BUTTON_DANGER : DIALOG_BUTTON_NEUTRAL} disabled={current.kind === "prompt" && !draft.trim()} onClick={() => finish(current.kind === "prompt" ? draft.trim() : true)}>{current.kind === "alert" ? "知道了" : "确认"}</button>
    </div>
  </AppModal>;
}
