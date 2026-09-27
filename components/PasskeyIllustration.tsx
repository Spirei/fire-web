"use client";

import { useState } from "react";

export default function PasskeyIllustration() {
  const [failed, setFailed] = useState(false);
  if (!failed) return <img className="pk-security-art" src="/api/system-assets/passkey" width={1125} height={492} fetchPriority="high" alt="通行密钥保护登录安全" onError={() => setFailed(true)} />;
  return <svg className="pk-security-art" viewBox="0 0 420 220" role="img" aria-label="通行密钥保护登录安全">
    <defs><linearGradient id="passkey-shield" x2="1" y2="1"><stop stopColor="#6288ff"/><stop offset="1" stopColor="#0064e0"/></linearGradient></defs>
    <path d="M210 28 278 52v57c0 44-43 73-68 83-25-10-68-39-68-83V52Z" fill="url(#passkey-shield)"/>
    <circle cx="210" cy="94" r="17" fill="none" stroke="white" strokeWidth="7"/>
    <path d="M210 111v35m0-13h16" fill="none" stroke="white" strokeWidth="7" strokeLinecap="round"/>
  </svg>;
}
