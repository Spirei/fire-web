import Link from "next/link";
import { headers } from "next/headers";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { cleanupOrphanFiles } from "@/lib/fileCleanup";
import { getShowcaseImportRows } from "@/lib/showcaseImportRows";
import ModelPipelineFlow from "@/components/showcase/ModelPipelineFlow";
import "@/components/showcase/model-importer.css";
import "@/components/showcase/capsule.css";
import "@/components/showcase/model-pipeline.css";

export const dynamic = "force-dynamic";

export default async function ModelPipelinePage() {
  const cookie = (await headers()).get("cookie") ?? "";
  const user = getAuthUser(new Request("http://localhost/", { headers: { cookie } }));
  if (!user || !isAdmin(user)) {
    return <main className="mpl-denied"><h1>{user ? "没有权限" : "请先登录"}</h1><p>车型上传流程只向管理员开放。</p><Link href="/">返回首页</Link></main>;
  }
  cleanupOrphanFiles({ scope: "showcase-unsaved" });

  return (
    <main className="mpl-page">
      <div className="mpl-shell">
        <header className="mpl-topbar">
          <Link href="/" className="mpl-wordmark" aria-label="返回 Fire 首页"><span className="mpl-brand-mark">F</span>FIRE <i>/</i> SHOWCASE</Link>
          <Link href="/showcase/import" className="mpl-top-link">车型管理 <span aria-hidden="true">↗</span></Link>
        </header>

        <section className="mpl-hero" aria-labelledby="pipeline-title">
          <p className="mpl-eyebrow">MODEL PIPELINE <span>/</span> 车型上传</p>
          <h1 id="pipeline-title">一台车，从原件到上线。</h1>
        </section>

        <div className="mpl-flow" aria-label="车型上传七步流程">
          <ModelPipelineFlow existing={getShowcaseImportRows()} />
          <section className="mpl-step" id="verify" aria-labelledby="verify-title">
            <div className="mpl-step-head">
              <span className="mpl-step-no">07</span>
              <h2 id="verify-title">逐档验收</h2>
              <span className="mpl-step-place">桌面 + 手机</span>
            </div>
            <p className="mpl-step-detail">测试 1K / 2K / 4K / RAW、刷新与失败重试；以实际画面加载成功为准。</p>
            <div className="mpl-step-foot"><span>产物</span><strong>车型上线</strong><Link href="/">打开首页 <span aria-hidden="true">↗</span></Link></div>
          </section>
        </div>

        <footer className="mpl-footer"><span>手动上传高清副本上限 96 MiB；群晖处理直接挂载产物。</span><Link href="/showcase/import">进入车型管理 <span aria-hidden="true">↗</span></Link></footer>
      </div>
    </main>
  );
}
