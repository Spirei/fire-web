import Link from "next/link";
import { headers } from "next/headers";
import { cleanupOrphanFiles } from "@/lib/fileCleanup";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getShowcaseImportRows } from "@/lib/showcaseImportRows";
import ModelImporter from "@/components/showcase/ModelImporter";
import "@/components/showcase/model-importer.css";
import "@/components/showcase/capsule.css";

export const dynamic = "force-dynamic";

/**
 * 车型导入向导（登录后可用）。
 *
 * 首页右下角车型条末尾的「＋」进这里：上传 .glb → 服务端体检 → 预览里摆正 / 认轮子 → 写进
 * uploads 卷的 showroom.json，首页立刻多一辆车，全程不用改代码、不用重新发版。
 */
export default async function ShowcaseImportPage() {
  const headerList = await headers();
  const cookie = headerList.get("cookie") ?? "";
  const user = getAuthUser(new Request("http://localhost/", { headers: { cookie } }));
  if (!user || !isAdmin(user)) {
    return (
      <main style={{ maxWidth: 640, margin: "18vh auto", padding: "0 24px", color: "var(--sc-ink, #e8eaee)" }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>{user ? "没有权限" : "请先登录"}</h1>
        <p style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.7 }}>
          {user
            ? "车型是首页对外的公共内容（素材经 /uploads 公开可访问），导入 / 改参数 / 删除都限管理员。请用管理员账号登录，或"
            : "车型素材与导入参数都写在服务器的 uploads 卷里，管理员登录后就能导入与调整。请先登录，或"}
          <Link href="/" style={{ marginLeft: 6 }}>
            返回首页
          </Link>
          。
        </p>
      </main>
    );
  }
  cleanupOrphanFiles({ scope: "showcase-unsaved" });
  return (
    <main className="showcase-import">
      <ModelImporter existing={getShowcaseImportRows()} />
    </main>
  );
}
