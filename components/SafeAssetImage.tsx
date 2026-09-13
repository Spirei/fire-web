"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
  // 服务端内联素材不需要等待网络；SSR 与客户端首帧都直接显示，避免先闪默认图标。
  const [loaded, setLoaded] = useState(() => Boolean(src?.startsWith("data:")));
  const imageRef = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    setFailed(false);
    const image = imageRef.current;
    setLoaded(Boolean(image?.complete && image.naturalWidth > 0));
  }, [src]);

  if (!src || failed) return <>{fallback}</>;
  return (
    <span className="inline-grid flex-none place-items-center" style={style} title={title}>
      <span className={`col-start-1 row-start-1 ${loaded ? "opacity-0" : "opacity-100"}`} aria-hidden={loaded}>
        {fallback}
      </span>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        className={`col-start-1 row-start-1 ${loaded ? "opacity-100" : "opacity-0"} ${className}`}
        style={style}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
