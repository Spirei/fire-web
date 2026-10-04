import type { Metadata } from "next";
import "./globals.css";
import "./quote-pool.css";
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
import { readThemeFromCookieHeader } from "@/lib/theme";
import PwaRegister from "@/components/PwaRegister";
import LoginModal from "@/components/LoginModal";
import FileDropAnywhere from "@/components/FileDropAnywhere";
import { PrefsProvider } from "@/lib/prefsContext";
import { PREFS_COOKIE, parsePrefsCookie } from "@/lib/prefsCookie";
import SiteFavicon from "@/components/SiteFavicon";
import { initialSiteFavicon } from "@/lib/siteFavicon";
import { pwaArtwork, pwaIconUrl } from "@/lib/pwaIcon";
import PaletteProvider from "@/components/PaletteProvider";
import { PALETTE_KEY, paletteVariables, resolvePalette } from "@/lib/palettes";
import "@/styles/palettes.css";
import "@/styles/liquid-glass.css";
import AppDialogHost from "@/components/AppDialogHost";
import CapsuleScope from "@/components/CapsuleScope";
import ThemePreferenceProvider from "@/components/ThemePreferenceProvider";
import { ACCENT_KEY, accentVariables, resolveAccent } from "@/lib/appearance";
import { THEME_MODE_KEY, resolveThemeMode } from "@/lib/theme";
import "@/styles/capsules.css";
import TypographyProvider from "@/components/TypographyProvider";
import { FONT_KEY, FONT_WEIGHT_KEY, typographyVariables, customFontCss } from "@/lib/typography";
import "@/styles/typography.css";
import "@/styles/muse.css";
// Cached tab views must not own the lifetime of their global stylesheet.
import "@/styles/feed.css";
import "@/styles/api-requests.css";
import "@/styles/api-version.css";
import "@/styles/market-calendar.css";

export async function generateMetadata(): Promise<Metadata> {
  const settings = getSiteSettings();
  const icon = await initialSiteFavicon(settings.ico);
  return {
    title: settings.title,
    description: "一个轻量的股票记录网站：记录自选与持仓，自动汇总盈亏，数据保存在服务端。",
    icons: { icon }
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 服务端读取主题 Cookie：暗黑模式下 SSR 首帧即深色，避免刷新白屏
  const cookieStore = await cookies();
  // 与首页使用同一套默认值：没有主题 Cookie 的新访客首帧也是深色。
  const cookieTheme = readThemeFromCookieHeader(cookieStore.toString());
  // 用户偏好（「原文 / 简体 / 繁體 / 英文」、卡包排序、图表周期 …）镜像在 cookie 里：
  // 服务端首帧直接用它渲染，客户端首帧也是同一个值 —— 刷新不会再先闪默认值、再跳回用户的选择。
  const prefs = parsePrefsCookie(cookieStore.get(PREFS_COOKIE)?.value);
  const themeMode = resolveThemeMode(prefs[THEME_MODE_KEY], cookieTheme);
  const dark = (themeMode === "system" ? cookieTheme : themeMode) === "dark";
  const settings = getSiteSettings();
  const palette = resolvePalette(prefs[PALETTE_KEY]);
  const pwaIcon = await pwaArtwork(settings.pwaIcon || settings.ico);
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
      data-palette={palette.id}
      data-accent={resolveAccent(prefs[ACCENT_KEY]).id}
      data-theme-mode={themeMode}
      data-material={palette.glass ? "glass" : "solid"}
      style={{ ...paletteVariables(palette.id), ...accentVariables(prefs[ACCENT_KEY]), ...typographyVariables(prefs[FONT_KEY], prefs[FONT_WEIGHT_KEY]) }}
    >
      <head>
        <style>{customFontCss(prefs[FONT_KEY])}</style>
        {/* Google 翻译（含 Chrome 内置翻译）看到这一条就不再动这个页面 */}
        <meta name="google" content="notranslate" />
        <script dangerouslySetInnerHTML={{ __html: `try{if(document.documentElement.dataset.themeMode==='system'){document.documentElement.classList.toggle('dark',matchMedia('(prefers-color-scheme: dark)').matches);}}catch(e){}` }} />
        {/* PWA：可安装（Chrome「在应用中打开」/ Safari 添加到主屏幕） */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content={dark ? palette.dark[0] : palette.light[0]} />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content={settings.logoText || "Alcor"} />
        <link rel="apple-touch-icon" sizes="180x180" href={pwaIconUrl(pwaIcon.version, 180)} />
        {/* 旧品牌本地缓存迁移 + 主题防闪兜底 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var ls=localStorage,ks=Object.keys(ls),legacy='sto'+'cklog',legacyTheme=ls.getItem(legacy+'.theme');for(var i=0;i<ks.length;i++){var k=ks[i];if(k.slice(0,legacy.length)===legacy){var n='fire'+k.slice(legacy.length);if(ls.getItem(n)===null)ls.setItem(n,ls.getItem(k));ls.removeItem(k);}}var root=document.documentElement,hasThemeCookie=/(?:^|; *)(?:fire_theme|stocklog_theme)=/.test(document.cookie);if(!hasThemeCookie){var t=ls.getItem('fire.theme')||legacyTheme;if(t==='dark'||t==='light')root.classList.toggle('dark',t==='dark');}var st=root.style;var sp=Number(ls.getItem('fire:asset-analysis:split-v1'));if(sp>=24&&sp<=52){st.setProperty('--asset-left-fr',sp+'fr');st.setProperty('--asset-right-fr',(100-sp)+'fr');}var tp=JSON.parse(ls.getItem('fire:trading-square-window-pos')||'null');if(tp&&typeof tp.x==='number'&&typeof tp.y==='number'&&isFinite(tp.x)&&isFinite(tp.y)&&tp.x>-10000&&tp.x<10000&&tp.y>=0){st.setProperty('--trading-x',tp.x+'px');st.setProperty('--trading-y',tp.y+'px');}}catch(e){}`
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: `if(location.pathname==='/simple-app'){document.documentElement.classList.add('simple-app-active');try{document.documentElement.classList.toggle('dark',localStorage.getItem('fire-simple-theme')==='dark');var sw=JSON.parse(localStorage.getItem('fire-simple-win')||'null');if(sw&&Number.isFinite(sw.w))document.documentElement.style.setProperty('--saved-win-w',Math.max(360,sw.w)+'px');}catch(e){}}` }} />
      </head>
      <body className="font-sans">
        <CapsuleScope />
        <PrefsProvider initialPrefs={prefs}>
          <ThemePreferenceProvider initialTheme={dark ? "dark" : "light"}>
          <PaletteProvider>
            <TypographyProvider>
            <SiteFavicon />
            <PwaRegister />
            {/* 全站拖拽上传：文件拖进页面就近落到最近的上传入口 */}
            <FileDropAnywhere />
            <TimeMachine />
            <SiteBg />
            <LoginModal />
            <AppDialogHost />
            {children}
            </TypographyProvider>
          </PaletteProvider>
          </ThemePreferenceProvider>
        </PrefsProvider>
      </body>
    </html>
  );
}
