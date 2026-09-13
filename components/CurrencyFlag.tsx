"use client";

import { useFlagIcon } from "@/lib/useAssetIcons";
import SafeAssetImage from "@/components/SafeAssetImage";
import { defaultFlagUrl } from "@/lib/flagAssets";

export default function CurrencyFlag({
  market,
  size = 18,
  className = ""
}: {
  market: string;
  size?: number;
  className?: string;
}) {
  const code = (market || "").trim().toLowerCase();
  const customUrl = useFlagIcon(code);
  if (!/^[a-z]{2}$/.test(code)) return null;
  // 素材库首屏注入 / 按代码请求优先；内置素材路径仅作为缺项安全兜底。
  const src = customUrl || defaultFlagUrl(code);
  return (
    <SafeAssetImage
      src={src}
      title={market}
      className={`block flex-none rounded-full object-cover ${className}`}
      style={{ width: size, height: size }}
      fallback={
        <span
          className={`inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-bg-gray ${className}`}
          style={{ width: size, height: size }}
          title={market}
          aria-hidden
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[62%] w-[62%] text-muted">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z" />
          </svg>
        </span>
      }
    />
  );
}
