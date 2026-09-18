import ShowcaseStage from "@/components/showcase/ShowcaseStage";
import { MCL35M_SHOWCASE } from "@/components/showcase/presets/mcl35m";

/**
 * 首页：整页是 3D 展示台（滚动叙事），车型与镜头都来自 preset。
 * 换车只需要在 components/showcase/presets 下新增/替换一份配置。
 */
export default function HomePage() {
  return <ShowcaseStage config={MCL35M_SHOWCASE} />;
}
