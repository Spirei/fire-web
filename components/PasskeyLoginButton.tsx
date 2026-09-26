"use client";
import { useEffect, useRef, useState } from "react";
import { startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";
import { passkeyError, passkeyRequest, passkeyRead, PasskeyRequestError } from "@/lib/passkeyClient";
import { isPublicPasskeyConfig } from "@/lib/passkeyConfig";

export default function PasskeyLoginButton({ disabled, onSuccess, onBusy, onError }: { disabled: boolean; onSuccess: () => void; onBusy: (busy: boolean) => void; onError: (error: string) => void }) {
  const [available, setAvailable] = useState(false);
  const inFlight = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const ceremonyActive = useRef(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!window.isSecureContext || !window.PublicKeyCredential) return;
    passkeyRead("/api/auth/passkeys/config", controller.signal).then(config => {
      if (active) setAvailable(isPublicPasskeyConfig(config) && config.enabled && config.origin === window.location.origin);
    }).catch(() => {});
    return () => {
      active = false; controller.abort(); operation.current?.abort();
      if (ceremonyActive.current) WebAuthnAbortService.cancelCeremony();
    };
  }, []);
  async function login() {
    if (inFlight.current || disabled) return;
    inFlight.current = true; onBusy(true); onError("");
    const controller = new AbortController(); operation.current = controller;
    try {
      const { options, requestId } = await passkeyRequest({ action: "login-options" }, "POST", "/api/auth/passkeys", controller.signal);
      if (!options || typeof requestId !== "string" || !requestId) throw new Error("验证信息响应异常，请重试");
      ceremonyActive.current = true;
      let response;
      try { response = await startAuthentication({ optionsJSON: options }); }
      finally { ceremonyActive.current = false; }
      if (controller.signal.aborted) return;
      const result = await passkeyRequest({ action: "login-verify", requestId, response }, "POST", "/api/auth/passkeys", controller.signal);
      if (result.ok !== true) throw new PasskeyRequestError("登录结果未确认，请刷新页面", 200, true);
      onSuccess();
    } catch (error) { if (!controller.signal.aborted) onError(passkeyError(error)); }
    finally { inFlight.current = false; if (!controller.signal.aborted) onBusy(false); }
  }
  if (!available) return null;
  return <button type="button" disabled={disabled} onClick={login} className="btn btn-ghost mt-4 h-[46px] w-full gap-2 px-5 text-sm disabled:opacity-50">
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5"><circle cx="8" cy="8" r="4" /><path d="M2 21v-3a6 6 0 0 1 10-4.5M18 15v7m0-3h3" /><circle cx="18" cy="12" r="3" /></svg>
    通行密钥登录
  </button>;
}
