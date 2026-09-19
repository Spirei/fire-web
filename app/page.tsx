import HomeShowcase from "@/components/showcase/HomeShowcase";

/**
 * 首页：整页是 3D 展示台（滚动叙事）。
 * 车型清单在 components/showcase/presets/models.ts，加车只需放进 glb 再补一条配置。
 */
export default function HomePage() {
  return <HomeShowcase />;
}
