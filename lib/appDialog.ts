"use client";

import { clientRandomId } from "@/lib/randomId";

export type AppDialogRequest = {
  id: string;
  kind: "alert" | "confirm" | "prompt";
  title: string;
  message: string;
  placeholder?: string;
  danger?: boolean;
  resolve: (value: boolean | string | null) => void;
};

const EVENT = "fire:app-dialog";

function request(kind: AppDialogRequest["kind"], message: string, options: { title?: string; placeholder?: string; danger?: boolean } = {}) {
  return new Promise<boolean | string | null>((resolve) => {
    // 不能用 crypto.randomUUID：局域网 HTTP 访问时它不存在（非安全上下文），会直接抛错。
    window.dispatchEvent(new CustomEvent<AppDialogRequest>(EVENT, { detail: { id: clientRandomId("dlg-"), kind, title: options.title || (kind === "prompt" ? "请输入" : kind === "confirm" ? "确认操作" : "提示"), message, placeholder: options.placeholder, danger: options.danger, resolve } }));
  });
}

export const APP_DIALOG_EVENT = EVENT;
export const appAlert = (message: string, title?: string) => request("alert", message, { title }).then(() => undefined);
export const appConfirm = (message: string, options?: { title?: string; danger?: boolean }) => request("confirm", message, options).then(Boolean);
export const appPrompt = (message: string, options?: { title?: string; placeholder?: string }) => request("prompt", message, options).then((value) => typeof value === "string" ? value : null);
