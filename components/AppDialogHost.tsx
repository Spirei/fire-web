"use client";

import { useEffect, useState } from "react";
import { Capsule } from "@/components/Capsule";
import PasswordInput from "@/components/PasswordInput";
import AppModal, { ModalActions } from "@/components/AppModal";
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
  const promptValue = current.inputType === "password" ? draft : draft.trim();
  const PromptInput = current.inputType === "password" ? PasswordInput : "input";
  const finish = (value: boolean | string | null) => { current.resolve(value); setCurrent(null); };
  return <AppModal title={current.title} desc={current.message} onClose={() => finish(current.kind === "confirm" ? false : null)} size="sm" priority>
    {current.kind === "prompt" && <PromptInput type={current.inputType || "text"} autoComplete={current.inputType === "password" ? "current-password" : "off"} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) finish(promptValue); }} placeholder={current.placeholder} className="field w-full" />}
    <ModalActions>
      {current.kind !== "alert" && <Capsule variant="secondary" onClick={() => finish(current.kind === "confirm" ? false : null)}>取消</Capsule>}
      <Capsule variant={current.danger ? "danger" : "primary"} disabled={current.kind === "prompt" && !draft.trim()} onClick={() => finish(current.kind === "prompt" ? promptValue : true)}>{current.kind === "alert" ? "知道了" : "确认"}</Capsule>
    </ModalActions>
  </AppModal>;
}
