import { getSiteSettings } from "@/lib/settings";
import HomeContent from "@/components/HomeContent";
import { cookies } from "next/headers";
import { THEME_COOKIE } from "@/lib/theme";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, getUserByToken } from "@/lib/auth";
import { getFlagIconMap, getMarketIconMap, getStockIconMap, stockIconKeysForRecords } from "@/lib/assets";
import { CURRENCY_FLAG_CODES } from "@/lib/flagAssets";
import { listRecords } from "@/lib/store";
import { CurrencyProvider, DISPLAY_CURRENCY_COOKIE, type CurrencyCode } from "@/lib/currencyPrefs";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const settings = getSiteSettings();
  const cookieStore = await cookies();
  const currencyCookie = cookieStore.get(DISPLAY_CURRENCY_COOKIE)?.value as CurrencyCode | undefined;
  const initialDark = cookieStore.get(THEME_COOKIE)?.value === "dark";
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
  const initialUser = getUserByToken(token);
  const initialStockIcons = initialUser ? getStockIconMap(stockIconKeysForRecords(listRecords(initialUser.id))) : {};
  const initialMarketIcons = getMarketIconMap();
  const initialFlagIcons = getFlagIconMap(CURRENCY_FLAG_CODES);
  return <CurrencyProvider initialCurrency={currencyCookie ?? null}><HomeContent settings={settings} initialDark={initialDark} initialUser={initialUser} initialStockIcons={initialStockIcons} initialMarketIcons={initialMarketIcons} initialFlagIcons={initialFlagIcons} /></CurrencyProvider>;
}
