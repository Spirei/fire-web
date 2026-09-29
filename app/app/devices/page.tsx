import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getUserByToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "@/lib/auth";
import AppDeviceList from "@/components/AppDeviceList";
export const dynamic = "force-dynamic";
export const metadata = { title: "已连接设备 - Fire", robots: { index: false, follow: false } };
export default async function Page() {
  const store = await cookies();
  if (!getUserByToken(store.get(SESSION_COOKIE)?.value || store.get(LEGACY_SESSION_COOKIE)?.value || null)) redirect("/login");
  return <main className="mx-auto min-h-screen max-w-xl px-5 py-10 text-ink"><Link href="/settings">返回设置</Link><h1 className="my-6 text-2xl font-semibold">已连接设备</h1><AppDeviceList /></main>;
}
