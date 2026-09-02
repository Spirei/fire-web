"use client";

import { useEffect, useState } from "react";
import LoginForm from "@/components/LoginForm";
import { logoFontClass } from "@/lib/logoFont";

export const OPEN_LOGIN_EVENT = "fire:open-login";

export default function LoginModal() {
  const [open, setOpen] = useState(false);
  const [sideImage, setSideImage] = useState("");
  const [logoText, setLogoText] = useState("Fire");
  const [logoFont, setLogoFont] = useState("diatype");

  useEffect(() => {
    function openLogin() {
      fetch("/api/auth/setup-status")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.needsSetup) {
            window.location.assign("/setup");
            return;
          }
          setOpen(true);
        })
        .catch(() => setOpen(true));
    }
    window.addEventListener(OPEN_LOGIN_EVENT, openLogin);
    return () => window.removeEventListener(OPEN_LOGIN_EVENT, openLogin);
  }, []);

  useEffect(() => {
    fetch("/api/settings/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setSideImage(data?.settings?.loginSideImage ?? "");
        setLogoText(data?.settings?.logoText || "Fire");
        setLogoFont(data?.settings?.logoFont ?? "diatype");
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  const fontCls = logoFontClass(logoFont);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm">
      <div className="fixed inset-0" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="登录"
        className="relative z-10 flex w-full max-w-[880px] sm:min-h-[680px] overflow-hidden rounded-[22px] border border-white/10 bg-white shadow-[0_24px_70px_rgba(0,0,0,.45)] dark:border-[#2a3140] dark:bg-[#12161f]"
      >
        {/* 左侧品牌图（桌面上传图 / 兜底渐变） */}
        <aside className="relative hidden w-[52%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0f2b26] via-[#113a33] to-[#0a1512] p-8 sm:flex">
          {sideImage ? (
            <img src={sideImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
          <div className={`relative flex items-center gap-2.5 ${sideImage ? "opacity-0" : ""}`}>
            <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#1FBE9E] text-white">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M4 17 9 12l3 2.5 5-7" /><circle cx="17" cy="7.5" r="1.6" fill="#fff" stroke="none" /></svg>
            </span>
            <span className={`text-lg tracking-wide text-white ${fontCls}`}>{logoText}</span>
          </div>
          <div className={`relative ${sideImage ? "opacity-0" : ""}`}>
            <p className="text-[24px] font-extrabold leading-tight text-white">记录投资点滴</p>
            <p className="mt-3 text-[13px] leading-relaxed text-white/60">自选 · 持仓 · 全球行情 · 财报日历 · 名人持仓</p>
          </div>
          <div className={`relative flex items-end gap-1 ${sideImage ? "opacity-0" : ""}`}>
            {[36, 24, 42, 30, 48, 26, 40].map((h, i) => (
              <span key={i} className="w-2.5 rounded-t bg-white/20" style={{ height: h }} />
            ))}
          </div>
        </aside>

        {/* 右侧表单区 */}
        <div className="flex w-full flex-1 items-center sm:min-w-0">
          <LoginForm onClose={() => setOpen(false)} />
        </div>
      </div>
    </div>
  );
}
