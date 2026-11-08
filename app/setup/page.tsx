import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import FirstRunSetup from "@/components/FirstRunSetup";
import { getSiteSettings } from "@/lib/settings";
import { getUserByToken, LEGACY_SESSION_COOKIE, needsSetup, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "首次设置 - Alcor"
};

export default async function SetupPage() {
  if (!await needsSetup()) {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
    redirect(await getUserByToken(token) ? "/global" : "/login");
  }
  const settings = await getSiteSettings();
  return (
    <div className="first-run-shell">
      <FirstRunSetup requireSetupToken={process.env.FIRE_ENVIRONMENT === "production"} initialBrand={{ logo: settings.siteLogo, favicon: settings.ico }} />
    </div>
  );
}
