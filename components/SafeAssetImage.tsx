"use client";

import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";

/**
 * 素材库图标安全加载：图片加载失败（如容器内默认素材文件缺失，或用户上传后文件被清理）
 * 时回退到内置默认图标，避免出现浏览器「? / 破图」占位。用于导航、货币/市场图标等场景。
 *
 * 图片始终参与绘制（不做 opacity 切换）：命中浏览器缓存时首帧就是真图，刷新不再先闪一次占位；
 * 尚未加载完成时图片是透明的，垫底的占位自然透出；alt 为空，加载失败也不会出现破图图标。
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
  fallback: React.ReactNode;
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
    <span className="inline-grid flex-none place-items-center" style={style} title={title}>
      <span className="col-start-1 row-start-1" aria-hidden>{fallback}</span>
      <img
        src={src}
        alt={alt}
        className={`col-start-1 row-start-1 ${className}`}
        style={style}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
