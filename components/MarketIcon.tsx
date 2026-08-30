"use client";

import { useAssetIcons } from "@/lib/useAssetIcons";

// 市场图标全部走本地素材库（含镜像打包的默认市场图标），不依赖远程 CDN。
// 无本地素材时回退为本地矢量地球，保证线上/线下、离线都稳定。

export default function MarketIcon({
  market,
  flag = "",
  size = 18,
  className = "",
  title
}: {
  market: string;
  flag?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const { marketIcons } = useAssetIcons(["market"]);
  const code = (market || "").trim().toUpperCase();
  const custom = marketIcons[code];
  // 无素材库市场图标时，回退本地打包的国旗（asset/flag，UK→gb），不依赖远程 CDN
  const flagIso = code === "UK" ? "gb" : code.toLowerCase();
  const flagSrc = /^[a-z]{2}$/.test(flagIso) ? `/uploads/asset/flag/${flagIso}.svg` : null;
  const imgStyle = { width: size, height: size };
  if (custom || flagSrc) {
    return (
      <img
        key={code}
        src={custom || flagSrc!}
        alt=""
        title={title ?? code}
        className={`block flex-none rounded-full object-cover ${className}`}
        style={imgStyle}
      />
    );
  }
  return (
    <span
      className={`inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-bg-gray ${className}`}
      style={imgStyle}
      title={title ?? (code || market)}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[62%] w-[62%] text-muted">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z" />
      </svg>
    </span>
  );
}
