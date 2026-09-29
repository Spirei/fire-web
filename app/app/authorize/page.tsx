import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUserByToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "@/lib/auth";
import { parseAppAuthorization } from "@/lib/appAuth";
import AppAuthorizationConsent from "@/components/AppAuthorizationConsent";
export const dynamic = "force-dynamic";
export const metadata = { title: "连接 Fire App", robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  let auth;
  try { auth = parseAppAuthorization(params); }
  catch { return <main className="mx-auto max-w-md px-6 py-20 text-ink"><h1 className="text-xl font-semibold">连接请求无效</h1><p className="mt-4 text-muted">请返回 Fire App 重新连接。</p></main>; }
  const store = await cookies();
  const user = getUserByToken(store.get(SESSION_COOKIE)?.value || store.get(LEGACY_SESSION_COOKIE)?.value || null);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/app/authorize?${new URLSearchParams({ ...auth }).toString()}`)}`);
  return <AppAuthorizationConsent authorization={auth} account={user.nickname || user.username} />;
}
