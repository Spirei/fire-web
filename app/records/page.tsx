import { redirect } from "next/navigation";
import { ACCOUNT_ASSETS_PATH } from "@/lib/workspaceRouting";

export const dynamic = "force-dynamic";

export default function RecordsPage() {
  redirect(ACCOUNT_ASSETS_PATH);
}
