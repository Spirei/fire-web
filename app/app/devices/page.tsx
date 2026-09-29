import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getUserByToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "@/lib/auth";
import AppDeviceList from "@/components/AppDeviceList";
import AppConnectionShell from "@/components/AppConnectionShell";
import { appConnectionBrand } from "@/lib/appConnectionBrand";
import { getSiteSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";
export function generateMetadata() { return { title: `管理授权 - ${appConnectionBrand(getSiteSettings()).siteName}`, robots: { index: false, follow: false } }; }
export default async function Page() {
  const store = await cookies();
  const brand = appConnectionBrand(getSiteSettings());
  if (!getUserByToken(store.get(SESSION_COOKIE)?.value || store.get(LEGACY_SESSION_COOKIE)?.value || null)) redirect("/login?next=%2Fapp%2Fdevices");
  return <AppConnectionShell brand={brand} serverName={(await headers()).get("host") || "Fire Web"} section="管理授权" wide headerAction={<Link className="app-connection-back" href="/settings?category=account">返回设置</Link>}>
    <div className="app-devices-heading"><h1>管理授权</h1></div><AppDeviceList brand={brand} />
  </AppConnectionShell>;
}
