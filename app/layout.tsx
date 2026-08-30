import type { Metadata } from "next";
import "./globals.css";
import "@/styles/responsive-base.css";
import "@/styles/mobile.css";
import "@/styles/tablet.css";
import "@/styles/desktop.css";
import "@/styles/touch.css";
import { cookies } from "next/headers";
import { getSiteSettings } from "@/lib/settings";
import SiteBg from "@/components/SiteBg";
import { THEME_COOKIE } from "@/lib/theme";
import PwaRegister from "@/components/PwaRegister";
import LoginModal from "@/components/LoginModal";

export async function generateMetadata(): Promise<Metadata> {
  const settings = getSiteSettings();
  return {
    title: settings.title,
    description: "一个轻量的股票记录网站：记录自选与持仓，自动汇总盈亏，数据保存在服务端。",
    icons: settings.ico ? { icon: settings.ico } : undefined
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 服务端读取主题 Cookie：暗黑模式下 SSR 首帧即深色，避免刷新白屏
  const cookieStore = await cookies();
  const legacyThemeCookie = "sto" + "cklog_theme";
  const dark = cookieStore.get(THEME_COOKIE)?.value === "dark" || cookieStore.get(legacyThemeCookie)?.value === "dark";
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={dark ? "dark" : ""}
      style={{ backgroundColor: dark ? "#0a0e19" : "#ffffff" }}
    >
      <head>
        {/* PWA：可安装（Chrome「在应用中打开」/ Safari 添加到主屏幕） */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content={dark ? "#0a0e19" : "#ffffff"} />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="投资记实" />
        <link rel="apple-touch-icon" href="/uploads/ico/pwa-192.png" />
        {/* 旧品牌本地缓存迁移 + 主题防闪兜底 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var ls=localStorage,ks=Object.keys(ls),legacy='sto'+'cklog',legacyTheme=ls.getItem(legacy+'.theme');for(var i=0;i<ks.length;i++){var k=ks[i];if(k.slice(0,legacy.length)===legacy){var n='fire'+k.slice(legacy.length);if(ls.getItem(n)===null)ls.setItem(n,ls.getItem(k));ls.removeItem(k);}}var t=ls.getItem('fire.theme')||legacyTheme;if(t==='dark'){document.documentElement.classList.add('dark');document.documentElement.style.backgroundColor='#0a0e19';}}catch(e){}`
          }}
        />
      </head>
      <body className="font-sans">
        <PwaRegister />
        <SiteBg />
        <LoginModal />
        {children}
      </body>
    </html>
  );
}
