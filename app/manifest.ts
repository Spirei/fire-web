import type { MetadataRoute } from "next";
import { getSiteSettings } from "@/lib/settings";
import { pwaArtwork, pwaIconUrl } from "@/lib/pwaIcon";

// 构建期会静态预渲染 manifest 路由并触发 getSiteSettings()(读库),空库下 seed()
// 因缺少 INITIAL_ADMIN_* 抛错导致 next build 失败。标记为运行时动态,构建不预渲染,
// 运行时再读站点标题,也避免把构建期占位凭据写进 Dockerfile。
export const dynamic = "force-dynamic";

/** PWA Manifest：让网站在 Chrome / Edge / Safari 可安装（地址栏出现「安装应用 / 在应用中打开」） */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const settings = getSiteSettings();
  const { version } = await pwaArtwork(settings.pwaIcon || settings.ico);
  return {
    name: settings.title || "Fire - 投资记实",
    short_name: settings.title ? settings.title.slice(0, 12) : "投资记实",
    description: "记录自选与持仓、自动汇总盈亏的投资记账网站。",
    start_url: "/",
    id: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0e19",
    theme_color: "#0a0e19",
    lang: "zh-CN",
    icons: [
      { src: pwaIconUrl(version, 192), sizes: "192x192", type: "image/png" },
      { src: pwaIconUrl(version, 512), sizes: "512x512", type: "image/png" }
    ]
  };
}
