import Link from "next/link";
import { headers } from "next/headers";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { modelUrlExists, orderRanker, readRegistry, readStoredModels, resolveOrder } from "@/lib/showcaseModels";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import ModelImporter from "@/components/showcase/ModelImporter";

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
  const { order, builtinMeta } = readRegistry();
  // 清单里连内置那辆一起列出来：首页有几辆，这里就显示几行，不会对不上
  const builtin = SHOWCASE_MODELS.map((item) => {
    // 内置车的封面同样可以换：文件存在才用，缺失就回退成车型代号占位
    const cover = builtinMeta[item.id]?.cover ?? "";
    return {
      id: item.id,
      label: item.label,
      note: item.note,
      file: item.config.assets.model.split("?")[0].split("/").pop() ?? item.config.assets.model,
      cover: cover && modelUrlExists(cover) ? cover : "",
      // 内置车的预设里 wheelPattern / materialRules 可能是正则；这一行只读展示，统一转成字符串
      params: {
        ...item.config.model,
        wheelPattern: typeof item.config.model?.wheelPattern === "string" ? item.config.model.wheelPattern : undefined,
        materialRules: (item.config.model?.materialRules ?? []).map((rule) => ({
          match: typeof rule.match === "string" ? rule.match : String(rule.match),
          metalness: rule.metalness,
          roughness: rule.roughness
        }))
      },
      updatedAt: "",
      builtin: true
    };
  });
  const stored = readStoredModels();
  const existing = [
    ...builtin,
    ...stored.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      file: model.file,
      cover: model.cover ?? "",
      params: model.params,
      updatedAt: model.updatedAt,
      builtin: false
    }))
  ];
  // 卡片顺序就是服务端保存的顺序（与首页右下角车型条同源），刷新不会跳回默认排列
  const rank = orderRanker(resolveOrder(order, stored.map((model) => model.id)));
  return (
    <main className="showcase-import">
      <ModelImporter existing={[...existing].sort((a, b) => rank(a.id) - rank(b.id))} />
    </main>
  );
}
