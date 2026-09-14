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
    <div className="mt-6 flex justify-end gap-2">
      {current.kind !== "alert" && <button type="button" className="btn btn-secondary" onClick={() => finish(current.kind === "confirm" ? false : null)}>取消</button>}
      <button type="button" className={current.danger ? "btn bg-[#c34f4f] text-white hover:bg-[#ad4545]" : "btn btn-brand"} disabled={current.kind === "prompt" && !draft.trim()} onClick={() => finish(current.kind === "prompt" ? draft.trim() : true)}>{current.kind === "alert" ? "知道了" : "确认"}</button>
    </div>
  </AppModal>;
}
