import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getUserByToken, isAdmin, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DeployStatusLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
  let user: Awaited<ReturnType<typeof getUserByToken>> = null;
  try {
    user = await getUserByToken(token);
  } catch {
    // A busy or briefly unreachable backend must not replace the page with
    // the global error screen; keep the route and offer a reload.
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4 text-slate-900 dark:bg-[#0b0f16] dark:text-slate-100">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <h1 className="text-base font-medium">发布状态暂时无法加载</h1>
          <p className="mt-2 text-sm text-slate-500">登录状态核对失败，请稍后重新加载。</p>
          <a href="/deploy-status" className="mt-5 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">重新加载</a>
        </div>
      </main>
    );
  }
  if (!isAdmin(user)) notFound();
  return children;
}
