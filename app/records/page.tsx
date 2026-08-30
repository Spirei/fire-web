import { redirect } from "next/navigation";
import { getSiteSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function RecordsPage() {
  const settings = getSiteSettings();
  const def = settings.tabs.find((t) => t.default === true) ?? settings.tabs[0];
  redirect(def?.url || "/holdings");
}
