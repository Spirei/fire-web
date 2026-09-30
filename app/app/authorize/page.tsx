import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserByToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "@/lib/auth";
import { parseAppAuthorization } from "@/lib/appAuth";
import AppAuthorizationConsent from "@/components/AppAuthorizationConsent";
import AppConnectionShell from "@/components/AppConnectionShell";
import AppConnectionIcon from "@/components/AppConnectionIcon";
import { appConnectionBrand } from "@/lib/appConnectionBrand";
import { getSiteSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";
export function generateMetadata() { return { title: `连接 ${appConnectionBrand(getSiteSettings()).appName}`, robots: { index: false, follow: false } }; }
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const brand = appConnectionBrand(getSiteSettings());
  const serverName = (await headers()).get("host") || "Alcor Api";
  let auth;
  try { auth = parseAppAuthorization(params); }
  catch { return <AppConnectionShell serverName={serverName} brand={brand}><div className="app-connection-intro"><AppConnectionIcon src={brand.appIcon} /><h1>连接请求无效</h1><p>请返回 {brand.appName} 重新连接。</p></div></AppConnectionShell>; }
  const store = await cookies();
  const user = getUserByToken(store.get(SESSION_COOKIE)?.value || store.get(LEGACY_SESSION_COOKIE)?.value || null);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/app/authorize?${new URLSearchParams({ ...auth }).toString()}`)}`);
  return <AppAuthorizationConsent key={`${auth.state}:${user.id}`} brand={brand} authorization={auth} account={user.nickname || user.username} username={user.username} avatar={user.avatar || ""} serverName={serverName} />;
}
