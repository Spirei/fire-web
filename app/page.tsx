import { getSiteSettings } from "@/lib/settings";
import HomeContent from "@/components/HomeContent";
import { cookies } from "next/headers";
import { THEME_COOKIE } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const settings = getSiteSettings();
  const cookieStore = await cookies();
  const initialDark = cookieStore.get(THEME_COOKIE)?.value === "dark";
  return <HomeContent settings={settings} initialDark={initialDark} />;
}
