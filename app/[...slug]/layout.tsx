import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getSiteSettings } from "@/lib/settings";
import { getCelebAvatars } from "@/lib/celebsData";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, getUserByToken, needsSetup } from "@/lib/auth";
import { listRecords, listSecurityLogs } from "@/lib/store";
import RecordsApp from "@/components/RecordsApp";
import UserMenu from "@/components/UserMenu";
import SiteLogo from "@/components/SiteLogo";
import IndexTicker from "@/components/IndexTicker";
import Toaster from "@/components/Toaster";
import { getFlagIconMap, getMarketIconMap, getStockIconMap, stockIconKeysForRecords } from "@/lib/assets";
import { CURRENCY_FLAG_CODES, displayCurrencyFlagCode } from "@/lib/flagAssets";
import { cardLibraryForUser } from "@/lib/cardLibrary";
import { CurrencyProvider, DISPLAY_CURRENCY_COOKIE, type CurrencyCode } from "@/lib/currencyPrefs";
import { headers } from "next/headers";
import { unstable_noStore } from "next/cache";
import { fundState } from "@/lib/fundState";
import { listWatchGroups } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

export default async function SlugLayout({
  params
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  unstable_noStore();
  const { slug } = await params;
  const path = "/" + (slug || []).join("/");
  const settings = getSiteSettings();
  // 从原始 Cookie 头里取（API 路由里 cookies() 正常，但布局里读不到 —— 用 headers 统一走一条路）
  const rawCookie = (await headers()).get("cookie") || "";
  const CURRENCY_COOKIE_NAME = "fire-display-currency";
  const currencyCookie = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(CURRENCY_COOKIE_NAME + "="))
    ?.slice(CURRENCY_COOKIE_NAME.length + 1) as CurrencyCode | undefined;
  const currencyFlagCode = displayCurrencyFlagCode(currencyCookie);
  // 资产盈亏分析：应用壳内隐藏页签（不进导航菜单），直接按路径进入
  const specialTab = path === "/asset-pnl-analysis" ? { key: "pnl" } : null;
  let tab = specialTab ?? settings.tabs.find((t) => (t.url || `/${t.key}`) === path);
  // 个股详情直达：/watchlist/US.GOOGL —— 股票代码就是唯一标识，不再用 ?symbol= / ?filter=
  let initialSymbol: string | undefined;
  if (!tab) {
    const base = settings.tabs.find((t) => t.key === "watchlist");
    const baseUrl = base?.url || "/watchlist";
    if (path.startsWith(baseUrl + "/")) {
      const code = path.slice(baseUrl.length + 1);
      if (/^[A-Za-z]{2,5}\.[A-Z0-9._-]+$/.test(code)) {
        tab = base;
        initialSymbol = code.toUpperCase();
      }
    }
  }
  if (!tab) notFound();
  // 名人自定义头像（服务端读取）：SSR 首帧直接渲染最新头像，刷新不再闪现示例头像 / 空白
  const celebAvatars = getCelebAvatars();

  // 服务端鉴权守卫：未登录访问后台一律重定向到登录页（杜绝后台布局泄露）
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
  const user = getUserByToken(token);
  if (!user) {
    redirect(needsSetup() ? "/setup" : "/login");
  }

  // 后台首屏数据在服务端鉴权后直接读取。避免浏览器再次串行请求
  // /api/auth/me → records / activities / settings，首帧不再被全局转圈遮挡。
  const initialRecords = listRecords(user.id);
  // 自选股分组随记录一并进入服务端首屏，避免刷新时客户端请求完成前只显示“全部”。
  const initialWatchGroups = tab.key === "watchlist" ? listWatchGroups(user.id) : [];
  const initialUserLogs = listSecurityLogs(200, user.id);
  // 资金余额与持仓记录一起进入首屏，避免切到“我的持仓”时先按 0 现金计算、随后再跳到完整净资产。
  const initialFundBalances = fundState(user.id).balances;
  // 当前账户涉及的股票图标随 HTML 首屏下发，不再等待客户端请求 3,000+ 条素材。
  // 杠杆 ETF 同时带上正股图标，兼容素材库的正股兜底规则。
  const initialStockIcons = getStockIconMap(stockIconKeysForRecords(initialRecords));
  // 市场图标一并首屏下发：市场下拉 / 筛选首帧就是素材库图标，不再等客户端请求
  const initialMarketIcons = getMarketIconMap();
  const initialFlagIcons = getFlagIconMap(CURRENCY_FLAG_CODES);
  // 卡面库：只在访问该页时把清单 + 我的持有 / 金额 / 标签随首屏下发，
  // 避免「HTML → JS → 水合 → 再请求」的串行等待（卡面图片本身随后按需加载）
  const initialCardLibrary = tab.key === "cards" ? cardLibraryForUser(user.id) : null;

  return (
    <div className="min-h-screen bg-page">
      {/* 名人持仓页：HTML 阶段并行预加载自定义头像，刷新时人物不闪现文字占位 */}
      {tab.key === "celebs" &&
        Object.values(celebAvatars)
          .filter(Boolean)
          .map((u) => <link key={u} rel="preload" as="image" href={u} />)}
      {[...new Set(Object.values(initialStockIcons))].map((url) => <link key={url} rel="preload" as="image" href={url} />)}
      {[...new Set(Object.values(initialMarketIcons))].map((url) => <link key={url} rel="preload" as="image" href={url} />)}
      {initialFlagIcons[currencyFlagCode] && <link rel="preload" as="image" href={initialFlagIcons[currencyFlagCode]} />}
      <Toaster />
      <header className="app-shell-header site-header sticky top-0 z-50 h-[72px] border-b border-edge/80">
        <div className="mx-auto flex h-full max-w-[1140px] items-center gap-5 px-6">
          <Link href="/" className="inline-flex flex-none items-center gap-2.5 hover:opacity-90">
            <SiteLogo initialLogo={settings.siteLogo} initialText={settings.logoText} initialFont={settings.logoFont} />
          </Link>
          <div className="app-shell-ticker min-w-0 overflow-hidden"><IndexTicker /></div>
          <div className="ml-auto flex flex-none items-center gap-2.5">
            <UserMenu initialUser={user} />
          </div>
        </div>
      </header>

      <main className="app-shell-main py-14">
        <CurrencyProvider initialCurrency={currencyCookie ?? null}>
        <RecordsApp
          initialTab={tab.key}
          initialSymbol={initialSymbol}
          initialCelebAvatars={celebAvatars}
          initialUser={user}
          initialRecords={initialRecords}
          initialWatchGroups={initialWatchGroups}
          initialUserLogs={initialUserLogs}
          initialFundBalances={initialFundBalances}
          initialStockIcons={initialStockIcons}
          initialMarketIcons={initialMarketIcons}
          initialFlagIcons={initialFlagIcons}
          initialCardLibrary={initialCardLibrary}
          initialSettings={{
            tabs: settings.tabs,
            groups: settings.groups,
            markets: settings.markets,
            marketLabels: settings.marketLabels,
            stockIconCdn: settings.stockIconCdn,
            marketBadges: settings.marketBadges,
            marketBadgesVisible: settings.marketBadgesVisible,
            allowRegister: settings.allowRegister,
            translationEnabled: settings.translationEnabled
          }}
        />
        </CurrencyProvider>
      </main>

      <footer className="app-shell-footer border-t border-edge bg-white px-6 pb-7 pt-10">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-between gap-3 text-xs text-faint">
          <span>© 2026 Fire · 记录仅供参考，不构成任何投资建议</span>
          <span className="app-shell-footer-detail">数据保存在服务端 data/records.json</span>
        </div>
      </footer>
    </div>
  );
}
