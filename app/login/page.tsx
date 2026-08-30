import type { Metadata } from "next";
import Link from "next/link";
import LoginForm from "@/components/LoginForm";
import SiteLogo from "@/components/SiteLogo";
import { getSiteSettings } from "@/lib/settings";
import { logoFontClass } from "@/lib/logoFont";

export const metadata: Metadata = {
  title: "登录 - Fire"
};

export default function LoginPage() {
  const settings = getSiteSettings();
  const logoFontCls = logoFontClass(settings.logoFont);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-gray/70 px-4 py-10 dark:bg-[#0a0e19]">
      {/* 左右分栏大卡片（参考长桥登录页：左品牌区 + 右表单区） */}
      <div className="flex w-full max-w-[940px] overflow-hidden rounded-[22px] border border-edge bg-white shadow-[0_24px_60px_rgba(10,14,25,.12)] dark:border-[#2a3140] dark:bg-[#12161f]">
        {/* 左侧品牌区（桌面端显示） */}
        <aside className="relative hidden w-[45%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#141b2b] via-[#0e1116] to-[#080a0f] p-10 lg:flex">
          {settings.loginSideImage ? (
            <img
              src={settings.loginSideImage}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          {/* 网格装饰 */}
          <div
            className={settings.loginSideImage ? "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300" : "pointer-events-none absolute inset-0 opacity-[0.07]"}
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
              backgroundSize: "44px 44px"
            }}
          />
          {/* 顶部品牌 */}
          <div className={settings.loginSideImage ? "relative flex items-center gap-2.5 opacity-0" : "relative flex items-center gap-2.5"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#1FBE9E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
              <path d="M4 17 9 12l3 2.5 5-7" />
              <circle cx="17" cy="7.5" r="1.6" fill="#fff" stroke="none" />
            </svg>
            <span className={`text-lg tracking-wide text-white ${logoFontCls}`}>Fire</span>
          </div>
          {/* 标语 */}
          <div className={settings.loginSideImage ? "relative opacity-0" : "relative"}>
            <p className="text-[30px] font-extrabold leading-tight text-white">记录投资点滴</p>
            <p className="mt-4 text-sm leading-relaxed text-white/55">
              自选 · 持仓 · 全球行情 · 财报日历 · 名人持仓
            </p>
            <div className="mt-8 space-y-2.5">
              {["资产盈亏一目了然", "多市场实时行情", "数据私有化保存"].map((f) => (
                <div key={f} className="flex items-center gap-2 text-[13px] text-white/70">
                  <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-[#1FBE9E]/20">
                    <svg viewBox="0 0 24 24" fill="none" stroke="#1FBE9E" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  </span>
                  {f}
                </div>
              ))}
            </div>
          </div>
          {/* 底部折线装饰 */}
          <svg viewBox="0 0 320 110" fill="none" className={settings.loginSideImage ? "relative w-full opacity-0" : "relative w-full"}>
            <path d="M4 92 78 62l54 14 68-42 52-18 64 24" stroke="#1FBE9E" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
            <circle cx="316" cy="40" r="5" fill="#fff" />
            <path d="M4 100h312" stroke="rgba(255,255,255,.14)" strokeWidth="1" />
          </svg>
        </aside>

        {/* 右侧表单区 */}
        <div className="flex min-w-0 flex-1 flex-col justify-center px-6 py-10 sm:px-12">
          {/* 移动端顶部品牌 */}
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" stroke="#1FBE9E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
              <path d="M4 17 9 12l3 2.5 5-7" />
              <circle cx="17" cy="7.5" r="1.6" fill="#1FBE9E" stroke="none" />
            </svg>
            <span className={`text-base ${logoFontCls}`}>Fire</span>
          </div>
          <LoginForm />
        </div>
      </div>

      <footer className="mt-6 text-center text-xs text-faint">
        © 2026 Fire · 记录仅供参考，不构成任何投资建议
      </footer>
    </div>
  );
}
