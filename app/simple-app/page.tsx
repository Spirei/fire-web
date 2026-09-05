import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import SimpleAppClient from "./SimpleAppClient";
import "./simple-app.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fire 简化版"
};

export default async function SimpleAppPage() {
  const incoming = await headers();
  const request = new Request("http://localhost/simple-app", { headers: incoming });
  if (!getAuthUser(request)) redirect("/login?next=%2Fsimple-app");
  return <SimpleAppClient />;
}
