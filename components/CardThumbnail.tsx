"use client";

import Image from "next/image";
import { useState } from "react";

/** Display-sized previews share Next's on-disk image cache; detail/download URLs stay original. */
export default function CardThumbnail({ src, alt, sizes, className, eager = false, highPriority = false }: {
  src?: string; alt: string; sizes: string; className?: string; eager?: boolean; highPriority?: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!src) return <span className={`block ${className || ""}`} aria-hidden="true" />;
  // Never proxy arbitrary external URLs or private uploads through the public optimizer.
  const optimize = src.startsWith("/uploads/") && !src.startsWith("/uploads/reports/") &&
    !src.startsWith("//") && !/\.svg(?:[?#]|$)/i.test(src) && failedSource !== src;
  if (!optimize) return <img src={src} alt={alt} className={className} loading={eager ? "eager" : "lazy"} fetchPriority={highPriority ? "high" : "auto"} decoding="async" draggable={false} />;
  return <Image src={src} alt={alt} width={640} height={404} sizes={sizes} quality={90}
    className={className} loading={eager ? "eager" : "lazy"} fetchPriority={highPriority ? "high" : "auto"}
    decoding="async" draggable={false} onError={() => setFailedSource(src)} />;
}
