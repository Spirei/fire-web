import Link from "next/link";
import { headers } from "next/headers";
import { getAuthUser, isAdmin } from "@/lib/auth";
import "@/components/showcase/model-pipeline.css";

export const dynamic = "force-dynamic";

const steps = [
  {
    id: "source",
    place: "本机",
    title: "准备原件",
    detail: "保留自包含的原始 GLB；外置 textures 先打包。网站主模型上限 250 MiB。",
    result: "原始车型.glb"
  },
  {
    id: "local",
    place: "本机工具",
    title: "导出附件",
    detail: "用原件导出 1K 首页预览；大模型按需生成 UASTC 高清副本。原件不改动。",
    result: "*-preview.glb · *-optimized.glb（按需）",
    command: "cd tools/model-optimizer && npm start"
  },
  {
    id: "upload",
    place: "车型管理",
    title: "上传并体检",
    detail: "上传原始 GLB，检查网格、材质和贴图。体检通过前，文件不会正式入库。",
    result: "体检通过",
    href: "/showcase/import#upload",
    action: "前往选文件"
  },
  {
    id: "tune",
    place: "模型工作台",
    title: "调校车型",
    detail: "校正名称、车长、朝向、轮胎和漆面；等预览真正加载完成再保存。",
    result: "已确认参数"
  },
  {
    id: "save",
    place: "服务器",
    title: "保存入库",
    detail: "原件与参数写入 uploads 模型目录和 showroom.json，车型进入清单；未验证前可先隐藏首页。",
    result: "车型卡片"
  },
  {
    id: "attach",
    place: "车型卡片",
    title: "补齐附件",
    detail: "上传 1K 预览（≤32 MiB）；有同源 UASTC 副本时，再上传移动端原画（≤96 MiB）。",
    result: "首页预览 · 可选高清副本",
    href: "/showcase/import#model-list",
    action: "前往车型卡片"
  },
  {
    id: "verify",
    place: "桌面 + 手机",
    title: "逐档验收",
    detail: "测试 1K / 2K / 4K / RAW、刷新与失败重试；以实际画面加载成功为准。",
    result: "车型上线"
  }
] as const;

export default async function ModelPipelinePage() {
  const cookie = (await headers()).get("cookie") ?? "";
  const user = getAuthUser(new Request("http://localhost/", { headers: { cookie } }));
  if (!user || !isAdmin(user)) {
    return <main className="mpl-denied"><h1>{user ? "没有权限" : "请先登录"}</h1><p>车型上传流程只向管理员开放。</p><Link href="/">返回首页</Link></main>;
  }

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
          {steps.map((step, index) => (
            <section className="mpl-step" id={step.id} key={step.id} aria-labelledby={`${step.id}-title`}>
              <div className="mpl-step-head">
                <span className="mpl-step-no">{String(index + 1).padStart(2, "0")}</span>
                <h2 id={`${step.id}-title`}>{step.title}</h2>
                <span className="mpl-step-place">{step.place}</span>
              </div>
              <p className="mpl-step-detail">{step.detail}</p>
              <div className="mpl-step-foot"><span>产物</span><strong>{step.result}</strong>
                {"href" in step && <Link href={step.href}>{step.action} <span aria-hidden="true">↗</span></Link>}
              </div>
              {"command" in step && <code className="mpl-command">{step.command}</code>}
            </section>
          ))}
        </div>

        <footer className="mpl-footer"><span>超过 96 MiB 的高清副本暂不能从网页上传；直接复制 GLB 到 NAS 不等于完成同源校验。</span><Link href="/showcase/import">进入车型管理 <span aria-hidden="true">↗</span></Link></footer>
      </div>
    </main>
  );
}
