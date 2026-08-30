"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * 素材库图标安全加载：图片加载失败（如容器内默认素材文件缺失，或用户上传后文件被清理）
 * 时回退到内置默认图标，避免出现浏览器「? / 破图」占位。用于导航、货币/市场图标等场景。
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
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      title={title}
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
