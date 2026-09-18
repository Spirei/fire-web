import McLarenStage from "@/components/mclaren/McLarenStage";

/**
 * 首页：整页是迈凯伦（F1）滚动叙事，原有的产品预览、功能说明、页脚与顶栏都已移除。
 * 这里只做一层深色容器，3D 场景在客户端挂载后才动态加载 three.js。
 */
export default function HomePage() {
  return (
    <main className="mcl-home">
      <McLarenStage />
    </main>
  );
}
