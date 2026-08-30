"use client";

import { useEffect, useState } from "react";
import { logoFontClass } from "@/lib/logoFont";

export default function SiteLogo({
  small = false,
  initialLogo = "",
  initialText = "",
  initialFont = "diatype"
}: {
  small?: boolean;
  initialLogo?: string;
  initialText?: string;
  initialFont?: string;
}) {
  // 初始值由服务端设置直接传入，避免刷新时闪现默认 logo
  const [logo, setLogo] = useState(initialLogo);
  const [text, setText] = useState(initialText);
  const [font, setFont] = useState(initialFont);

  useEffect(() => {
    function apply() {
      fetch("/api/settings/public")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          setLogo(data?.settings?.siteLogo ?? "");
          setText(data?.settings?.logoText ?? "");
          setFont(data?.settings?.logoFont ?? "diatype");
        })
        .catch(() => {});
    }
    apply();
    window.addEventListener("fire:settings-updated", apply);
    return () => window.removeEventListener("fire:settings-updated", apply);
  }, []);

  return (
    <span className="inline-flex items-center gap-2.5">
      {logo ? (
        <img src={logo} alt="logo" className={small ? "h-5 w-auto" : "h-7 w-auto"} />
      ) : (
        <span className={`inline-flex items-center justify-center bg-white text-ink-2 border border-edge-strong shadow-sm ${small ? "h-[26px] w-[26px] rounded-lg" : "h-[34px] w-[34px] rounded-[10px]"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M3 17l5-6 4 3 6-8" />
            <path d="M15 6h3v3" />
          </svg>
        </span>
      )}
      {text && <span className={`text-[19px] tracking-[0.2px] text-ink ${logoFontClass(font)}`}>{text}</span>}
    </span>
  );
}
