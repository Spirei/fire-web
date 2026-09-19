import HomeShowcase from "@/components/showcase/HomeShowcase";
import { DEFAULT_SHOWCASE_MODEL } from "@/components/showcase/presets/models";
import { listShowcaseOptions } from "@/lib/showcaseModels";
import { getAuthUser } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * 首页：整页是 3D 展示台（滚动叙事）。
 *
 * 车型清单 = 内置（MCL35M 随仓库分发）+ 手动导入（uploads 卷里的 showroom.json）。
 * 素材缺失的车型直接不进清单，避免访客看到点不动的空车型。
 */
export default async function HomePage() {
  const all = listShowcaseOptions();
  const present = all.filter((item) => item.present);
  const models = (present.length ? present : all.slice(0, 1)).map(({ id, label, note, config }) => ({
    id,
    label,
    note,
    config
  }));
  // 「＋导入车型」只给登录用户看：访客看到一个点进去要登录的入口没意义
  const headerList = await headers();
  const cookie = headerList.get("cookie") ?? "";
  const request = new Request("http://localhost/", { headers: { cookie } });
  const user = getAuthUser(request);
  return (
    <HomeShowcase
      models={models}
      canImport={Boolean(user)}
      defaultModelId={models.some((item) => item.id === DEFAULT_SHOWCASE_MODEL) ? DEFAULT_SHOWCASE_MODEL : models[0]?.id}
    />
  );
}
