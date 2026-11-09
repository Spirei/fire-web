"use client";

import { IconCamera, IconLoader2 } from "@tabler/icons-react";
import SafeAssetImage from "@/components/SafeAssetImage";

/** Shared, full-image upload target. It stays a sibling of edit/select actions. */
export default function AssetImageControl({ src, name, card = false, disabled = false, busy = false, onUpload }: {
  src?: string; name: string; card?: boolean; disabled?: boolean; busy?: boolean; onUpload?: () => void;
}) {
  const image = <SafeAssetImage src={src} alt={name} loading="lazy"
    style={{ width: "100%", height: "100%" }} className="h-full w-full object-contain"
    fallback={<span className="asset-image-fallback">{name.slice(0, 1)}</span>} />;
  return onUpload ? <button type="button" data-capsule="off" className={`asset-image-control${card ? " is-card" : ""}`}
    aria-label={`上传或更换${name}图片`} title="上传或更换图片" disabled={disabled || busy} onClick={onUpload}>
    {image}<span className="asset-image-overlay" aria-hidden="true">{busy ? <IconLoader2 size={20} className="animate-spin" /> : <IconCamera size={20} />}</span>
  </button> : <span className={`asset-image-control${card ? " is-card" : ""}`}>{image}</span>;
}
