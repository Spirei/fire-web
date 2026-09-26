"use client";
import { useEffect, useRef, useState } from "react";
import { passkeyError, passkeyRequest } from "@/lib/passkeyClient";

export default function PasskeyLoginButton({ disabled, onSuccess, onBusy, onError }: { disabled: boolean; onSuccess: () => void; onBusy: (busy: boolean) => void; onError: (error: string) => void }) {
  const [available, setAvailable] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    if (!window.isSecureContext || !window.PublicKeyCredential) return;
    fetch("/api/auth/passkeys/config", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(config => {
      if (active) setAvailable(!!config?.enabled && config.origin === window.location.origin);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function login() {
    if (inFlight.current || disabled) return;
    inFlight.current = true; onBusy(true); onError("");
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, requestId } = await passkeyRequest({ action: "login-options" });
      const response = await startAuthentication({ optionsJSON: options });
      await passkeyRequest({ action: "login-verify", requestId, response });
      onSuccess();
    } catch (error) { onError(passkeyError(error)); }
    finally { inFlight.current = false; onBusy(false); }
  }
  if (!available) return null;
  return <button type="button" disabled={disabled} onClick={login} className="btn btn-ghost mt-4 w-full gap-2 disabled:opacity-50">
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5"><circle cx="8" cy="8" r="4" /><path d="M2 21v-3a6 6 0 0 1 10-4.5M18 15v7m0-3h3" /><circle cx="18" cy="12" r="3" /></svg>
    通行密钥登录
  </button>;
}
