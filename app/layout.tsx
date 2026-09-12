import type { Metadata } from "next";
import "./globals.css";
import "@/styles/time-machine.css";
import TimeMachine from "@/components/TimeMachine";
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
import FileDropAnywhere from "@/components/FileDropAnywhere";

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
    /* 禁止整页翻译：翻译器会在水合前改写服务端 HTML（连 title 属性都会改，比如把「繁體」改成「繁体」），
       客户端水合时读到的还是原文，于是报 "Hydration failed because the server rendered text didn't match the client"。
       三道锁一起上：html 的 translate="no" + html 的 notranslate 类 + <meta name="google" content="notranslate">
       —— 前两个是 Google 的约定，Chrome 自带的翻译会认。
       中文繁简 / 英文需求走站内按钮（卡面库「原文 / 简体 / 繁體 / 英文」），不依赖机器翻译。 */
    <html
      lang="zh-CN"
      suppressHydrationWarning
      translate="no"
      className={dark ? "dark notranslate" : "notranslate"}
      style={{ backgroundColor: dark ? "#0a0e19" : "#ffffff" }}
    >
      <head>
        {/* Google 翻译（含 Chrome 内置翻译）看到这一条就不再动这个页面 */}
        <meta name="google" content="notranslate" />
        <script dangerouslySetInnerHTML={{ __html: `if(location.pathname==='/simple-app')document.documentElement.classList.add('simple-app-active');` }} />
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
            __html: `try{var ls=localStorage,ks=Object.keys(ls),legacy='sto'+'cklog',legacyTheme=ls.getItem(legacy+'.theme');for(var i=0;i<ks.length;i++){var k=ks[i];if(k.slice(0,legacy.length)===legacy){var n='fire'+k.slice(legacy.length);if(ls.getItem(n)===null)ls.setItem(n,ls.getItem(k));ls.removeItem(k);}}var t=ls.getItem('fire.theme')||legacyTheme;if(t==='dark'){document.documentElement.classList.add('dark');document.documentElement.style.backgroundColor='#0a0e19';}var st=document.documentElement.style;var sp=Number(ls.getItem('fire:asset-analysis:split-v1'));if(sp>=24&&sp<=52){st.setProperty('--asset-left-fr',sp+'fr');st.setProperty('--asset-right-fr',(100-sp)+'fr');}var tp=JSON.parse(ls.getItem('fire:trading-square-window-pos')||'null');if(tp&&typeof tp.x==='number'&&typeof tp.y==='number'&&isFinite(tp.x)&&isFinite(tp.y)&&tp.x>-10000&&tp.x<10000&&tp.y>=0){st.setProperty('--trading-x',tp.x+'px');st.setProperty('--trading-y',tp.y+'px');}}catch(e){}`
          }}
        />
      </head>
      <body className="font-sans">
        <PwaRegister />
        {/* 全站拖拽上传：文件拖进页面就近落到最近的上传入口 */}
        <FileDropAnywhere />
        <TimeMachine />
        <SiteBg />
        <LoginModal />
        {children}
      </body>
    </html>
  );
}
