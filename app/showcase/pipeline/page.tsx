import Link from "next/link";
import { headers } from "next/headers";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { cleanupOrphanFiles } from "@/lib/fileCleanup";
import { getShowcaseImportRows } from "@/lib/showcaseImportRows";
import ModelBookLibrary from "@/components/showcase/ModelBookLibrary";
import "@/components/showcase/model-importer.css";
import "@/components/showcase/capsule.css";
import "@/components/showcase/model-book-library.css";

export const dynamic = "force-dynamic";

export default async function ModelPipelinePage({ searchParams }: { searchParams: Promise<{ book?: string; page?: string }> }) {
  const cookie = (await headers()).get("cookie") ?? "";
  const user = getAuthUser(new Request("http://localhost/", { headers: { cookie } }));
  if (!user || !isAdmin(user)) {
    return <main className="mbl-denied"><h1>{user ? "没有权限" : "请先登录"}</h1><p>车型画册只向管理员开放。</p><Link href="/">返回首页</Link></main>;
  }
  cleanupOrphanFiles({ scope: "showcase-unsaved" });

  const existing = getShowcaseImportRows();
  const query = await searchParams;
  const initialBookId = query.book === "new" || existing.some((model) => model.id === query.book) ? query.book ?? "" : "";
  const rawPage = Number(query.page ?? 0);
  const initialPage = Number.isInteger(rawPage) ? Math.max(0, Math.min(6, rawPage)) : 0;
  return <ModelBookLibrary existing={existing} initialBookId={initialBookId} initialPage={initialPage} />;
}
