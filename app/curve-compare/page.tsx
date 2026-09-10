import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import CurveCompareClient from "@/components/CurveCompareClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收益曲线前后对比"
};

/** 诊断页：拿真实账本对比「改动前 / 现在」的曲线口径；真实金额，必须登录后才能看 */
export default async function CurveComparePage() {
  const incoming = await headers();
  const request = new Request("http://localhost/curve-compare", { headers: incoming });
  if (!getAuthUser(request)) redirect("/login?next=%2Fcurve-compare");
  return <CurveCompareClient />;
}
