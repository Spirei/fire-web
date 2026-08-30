import type { Metadata } from "next";
import Link from "next/link";
import SiteLogo from "@/components/SiteLogo";
import NotFoundActions from "@/components/NotFoundActions";
import { getSiteSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "页面未找到 · Fire",
  robots: { index: false, follow: false }
};

export default function NotFound() {
  const settings = getSiteSettings();

  return (
    <main className="relative isolate min-h-[100svh] overflow-hidden bg-[#fafafa] text-ink dark:bg-[#0a0e19] dark:text-[#edf0f5]">
      <div className="pointer-events-none absolute inset-0 opacity-60 dark:opacity-30" aria-hidden="true">
        <div className="absolute left-[-12rem] top-[-14rem] h-[34rem] w-[34rem] rounded-full bg-[radial-gradient(circle,rgba(255,152,40,.16),transparent_68%)]" />
        <div className="absolute bottom-[-16rem] right-[-10rem] h-[38rem] w-[38rem] rounded-full bg-[radial-gradient(circle,rgba(15,160,123,.13),transparent_68%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(10,14,25,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(10,14,25,.035)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:linear-gradient(to_bottom,black,transparent_82%)] dark:bg-[linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)]" />
      </div>

      <header className="relative z-10 mx-auto flex h-[76px] max-w-[1180px] items-center justify-between px-5 sm:px-8">
        <Link href="/" aria-label="返回首页" className="transition-opacity hover:opacity-75">
          <SiteLogo initialLogo={settings.siteLogo} initialText={settings.logoText} initialFont={settings.logoFont} />
        </Link>
        <span className="rounded-full border border-edge bg-white/70 px-3 py-1.5 text-[11px] font-semibold tracking-[.14em] text-muted backdrop-blur dark:border-white/10 dark:bg-white/[.05] dark:text-[#929bab]">
          LOST SIGNAL
        </span>
      </header>

      <section className="relative z-10 mx-auto grid min-h-[calc(100svh-76px)] max-w-[1180px] items-center gap-10 px-5 pb-16 pt-8 sm:px-8 lg:grid-cols-[.88fr_1.12fr] lg:pb-24">
        <div className="max-w-xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-edge bg-white/70 px-3 py-1.5 text-xs font-semibold text-muted shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/[.05] dark:text-[#aeb5c2]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff9828] shadow-[0_0_0_4px_rgba(255,152,40,.13)]" />
            页面已偏离预定轨迹
          </div>
          <h1 className="text-[clamp(3.25rem,9vw,7.5rem)] font-black leading-[.82] tracking-[-.07em] text-[#11151f] dark:text-[#f2f4f8]">
            4<span className="text-[#ff9828]">0</span>4
          </h1>
          <h2 className="mt-7 text-2xl font-bold tracking-tight sm:text-3xl">这笔页面，暂时无法成交。</h2>
          <p className="mt-4 max-w-md text-sm leading-7 text-muted dark:text-[#929bab] sm:text-[15px]">
            地址可能已更改、被移除，或者从未存在。别担心，你的持仓和数据都安然无恙。
          </p>
          <div className="mt-8">
            <NotFoundActions />
          </div>
          <p className="mt-8 text-xs text-faint dark:text-[#687181]">错误代码 · PAGE_NOT_FOUND</p>
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[570px]" aria-hidden="true">
          <div className="absolute inset-[8%] rounded-[32%] border border-edge/80 bg-white/55 shadow-[0_30px_80px_rgba(10,14,25,.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[.035] dark:shadow-[0_30px_90px_rgba(0,0,0,.25)]" />
          <svg viewBox="0 0 560 560" className="absolute inset-0 h-full w-full overflow-visible">
            <defs>
              <linearGradient id="lost-path" x1="70" y1="430" x2="500" y2="115" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0fa07b" />
                <stop offset=".56" stopColor="#6b7280" />
                <stop offset="1" stopColor="#ff9828" />
              </linearGradient>
              <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="7" />
              </filter>
            </defs>
            <path d="M72 395C131 382 144 324 207 326c74 2 74-113 147-98 60 13 56-86 134-96" fill="none" stroke="currentColor" strokeOpacity=".1" strokeWidth="18" strokeLinecap="round" />
            <path d="M72 395C131 382 144 324 207 326c74 2 74-113 147-98 60 13 56-86 134-96" fill="none" stroke="url(#lost-path)" strokeWidth="4" strokeLinecap="round" strokeDasharray="9 13" />
            <circle cx="72" cy="395" r="10" fill="#0fa07b" opacity=".2" filter="url(#soft-glow)" />
            <circle cx="72" cy="395" r="5" fill="#0fa07b" />
            <circle cx="488" cy="132" r="16" fill="#ff9828" opacity=".24" filter="url(#soft-glow)" />
            <circle cx="488" cy="132" r="6" fill="#ff9828" />
          </svg>
          <div className="absolute left-[30%] top-[39%] rotate-[-7deg] rounded-2xl border border-edge bg-white/90 px-4 py-3 shadow-[0_14px_35px_rgba(10,14,25,.11)] backdrop-blur dark:border-white/10 dark:bg-[#151a26]/90">
            <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-faint">Route status</p>
            <p className="mt-1 flex items-center gap-2 text-sm font-bold"><span className="h-2 w-2 rounded-full bg-[#ff9828]" />未找到</p>
          </div>
          <div className="absolute bottom-[18%] right-[14%] rounded-full border border-edge bg-white/85 px-3 py-2 text-[11px] font-semibold text-muted shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#151a26]/90 dark:text-[#aeb5c2]">
            重新规划中…
          </div>
        </div>
      </section>
    </main>
  );
}
