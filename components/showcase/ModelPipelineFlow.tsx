"use client";

import ModelImporter from "./ModelImporter";
import { usePersistedState } from "@/lib/usePersistedState";
import type { ImportedModelRow } from "./ModelImporter";

export default function ModelPipelineFlow({ existing }: { existing: ImportedModelRow[] }) {
  const [method, setMethod] = usePersistedState<"local" | "online">("fire:showcase:processing-method", "local");
  return <>
    <section className="mpl-step" id="source" aria-labelledby="source-title">
      <div className="mpl-step-head"><span className="mpl-step-no">01</span><h2 id="source-title">准备原件</h2><span className="mpl-step-place">本机</span></div>
      <p className="mpl-step-detail">保留自包含的原始 GLB；外置 textures 先打包。原件上限 250 MiB。</p>
      <div className="mpl-step-foot"><span>产物</span><strong>原始车型.glb</strong></div>
    </section>
    <section className="mpl-step" id="local" aria-labelledby="local-title">
      <div className="mpl-step-head"><span className="mpl-step-no">02</span><h2 id="local-title">选择处理位置</h2><span className="mpl-step-place">本机 / 群晖</span></div>
      <div className="mpl-methods" role="group" aria-label="模型附件处理位置">
        <button type="button" className={method === "local" ? "is-active" : ""} aria-pressed={method === "local"} onClick={() => setMethod("local")}>本机工具</button>
        <button type="button" className={method === "online" ? "is-active" : ""} aria-pressed={method === "online"} onClick={() => setMethod("online")}>群晖处理</button>
      </div>
      <p className="mpl-step-detail">{method === "online" ? "原件保存后自动排队，在独立容器生成 1K 预览及按需生成高清副本。" : "本机导出附件，再在第 06 步上传；原件始终不改动。"}</p>
      {method === "local" && <code className="mpl-command">cd tools/model-optimizer && npm start</code>}
      <div className="mpl-step-foot"><span>产物</span><strong>1K 预览 · 高清副本（按需）</strong></div>
    </section>
    <ModelImporter existing={existing} mode="pipeline" processingMethod={method} />
  </>;
}
