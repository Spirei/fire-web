import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import FirstRunSetup from "@/components/FirstRunSetup";
import { getUserByToken, LEGACY_SESSION_COOKIE, needsSetup, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "首次设置 - Fire"
};

export default async function SetupPage() {
  if (!needsSetup()) {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value ?? cookieStore.get(LEGACY_SESSION_COOKIE)?.value ?? null;
    redirect(getUserByToken(token) ? "/records" : "/login");
  }
  return (
    <div style={{ minHeight: "100dvh", background: "#0b0f16" }}>
      <FirstRunSetup requireSetupToken={process.env.NODE_ENV === "production"} />
    </div>
  );
}
