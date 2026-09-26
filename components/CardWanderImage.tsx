"use client";

import { useEffect, useRef, useState } from "react";
import CardThumbnail from "@/components/CardThumbnail";
import { wanderOriginalQueue } from "@/lib/cardImageQueue";

/** Keep the small preview visible until the original has finished decoding. */
export default function CardWanderImage({ src }: { src: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const original = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [originalReady, setOriginalReady] = useState(false);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !previewReady || originalReady) return;
    return wanderOriginalQueue.enqueue(async signal => {
      if (signal.aborted) return;
      const image = original.current;
      if (!image) return;
      let decoded = false;
      image.decoding = "async"; image.fetchPriority = "low";
      const abort = () => { if (!decoded) image.removeAttribute("src"); };
      signal.addEventListener("abort", abort, { once: true });
      const timeout = window.setTimeout(abort, 20000);
      try {
        image.src = src;
        await image.decode();
        decoded = true;
        if (!signal.aborted) setOriginalReady(true);
      } finally {
        clearTimeout(timeout); signal.removeEventListener("abort", abort);
      }
    });
  }, [src, visible, previewReady, originalReady]);
  return <span ref={root} className="card-wander-progressive" data-original-ready={originalReady}>
    {!originalReady && <CardThumbnail src={src} alt="" sizes="350px" eager onLoad={() => setPreviewReady(true)} />}
    <img ref={original} src={originalReady ? src : undefined} alt="" decoding="async" draggable={false}
      style={{ position: "absolute", inset: 0, opacity: originalReady ? 1 : 0 }} />
  </span>;
}
