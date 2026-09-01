import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getUserByToken, isAdmin, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DeployStatusLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
  if (!isAdmin(getUserByToken(token))) notFound();
  return children;
}
