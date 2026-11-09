"use client";

import Image from "next/image";
import { useState } from "react";
import { IconCreditCard } from "@tabler/icons-react";

/** Display-sized previews share Next's on-disk image cache; detail/download URLs stay original. */
export default function CardThumbnail({ src, alt, sizes, className, eager = false, highPriority = false, onLoad }: {
  src?: string; alt: string; sizes: string; className?: string; eager?: boolean; highPriority?: boolean; onLoad?: () => void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [unavailableSource, setUnavailableSource] = useState<string | null>(null);
  if (!src || unavailableSource === src) return <span className={`card-image-unavailable ${className || ""}`} role="img" aria-label={`${alt}，卡面暂不可用`} title="卡面暂不可用"><IconCreditCard size={30} aria-hidden="true" /></span>;
  // Never proxy arbitrary external URLs or private uploads through the public optimizer.
  const optimize = src.startsWith("/uploads/") && !src.startsWith("/uploads/reports/") &&
    !src.startsWith("//") && !/\.svg(?:[?#]|$)/i.test(src) && failedSource !== src;
  if (!optimize) return <img src={src} alt={alt} className={className} loading={eager ? "eager" : "lazy"} fetchPriority={highPriority ? "high" : "auto"} decoding="async" draggable={false} onLoad={onLoad} onError={() => setUnavailableSource(src)} />;
  return <Image src={src} alt={alt} width={640} height={404} sizes={sizes} quality={90}
    className={className} loading={eager ? "eager" : "lazy"} fetchPriority={highPriority ? "high" : "auto"}
    decoding="async" draggable={false} onLoad={onLoad} onError={() => setFailedSource(src)} />;
}
