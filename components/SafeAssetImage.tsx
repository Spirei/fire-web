"use client";

import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";

/**
 * 素材库图标安全加载：图片加载失败（如容器内默认素材文件缺失，或用户上传后文件被清理）
 * 时回退到内置默认图标，避免出现浏览器「? / 破图」占位。用于导航、货币/市场图标等场景。
 *
 * 图片始终参与绘制（不做 opacity 切换）：命中浏览器缓存时首帧就是真图，刷新不再先闪一次占位；
 * 尚未加载完成时图片是透明的，垫底的占位自然透出；alt 为空，加载失败也不会出现破图图标。
 *
 * 尺寸约定（重要）：外层 span 由 fallback 撑开，图片用 absolute 覆盖在 fallback 之上，
 * 因此调用方直接传 `h-full w-full` 这类百分比尺寸也是安全的。
 * 早先图片与 fallback 同处一个 grid 单元格、图片高度用百分比：单元格高度由内容决定（无限定值），
 * 百分比解析不出来 → 图片退回 SVG 固有尺寸（150×150 起）→ 被图标框 overflow:hidden 裁掉，
 * 只剩放大十几倍的碎片（设置-应用导航菜单里「资产分析 / 全球经济」显示成深色色块即此原因）。
 * 所以：图片尺寸要么由 fallback 或 style 给出确定值，要么显式传确定尺寸的 className；
 * 只传 src、fallback 为 null 时，必须用 style 给出确定尺寸。
 */
export default function SafeAssetImage({
  src,
  fallback,
  className = "",
  style,
  title,
  alt = ""
}: {
  src?: string | null;
  fallback: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) return <>{fallback}</>;
  return (
    <span className="relative inline-flex flex-none items-center justify-center" style={style} title={title}>
      <span aria-hidden>{fallback}</span>
      <img
        src={src}
        alt={alt}
        className={`absolute inset-0 ${className}`}
        style={style}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
