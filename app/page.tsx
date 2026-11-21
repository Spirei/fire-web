import { redirect } from "next/navigation";
import { ACCOUNT_ASSETS_PATH } from "@/lib/workspaceRouting";

export default function HomePage() {
  redirect(ACCOUNT_ASSETS_PATH);
}
