"use client";

import { useEffect, useRef, useState } from "react";
import { brokerIconUrl } from "@/lib/brokerIcons";
import { ensureBrokerIcons } from "@/lib/useAssetIcons";

/**
 * Broker artwork can lag behind a rename or a replaced file. Try the current
 * map, retry once past the browser cache, and only then use the name initial.
 */
export default function BrokerIcon({
  icons,
  name,
  size = 20,
  className = ""
}: {
  icons?: Record<string, string>;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const src = brokerIconUrl(icons, name);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryKey = useRef(0);

  useEffect(() => { setAttempt(0); setFailed(false); }, [src]);

  if (src && !failed) {
    const source = attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}_alcor_retry=${retryKey.current}` : src;
    return <img
      src={source}
      alt=""
      onError={() => {
        if (attempt === 0) {
          retryKey.current = Date.now();
          setAttempt(1);
          void ensureBrokerIcons(true);
        } else setFailed(true);
      }}
      style={{ width: size, height: size }}
      className={`flex-none rounded-full object-cover ${className}`}
    />;
  }

  return <span
    aria-hidden="true"
    style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }}
    className={`flex flex-none items-center justify-center rounded-full bg-white/70 font-bold text-muted dark:bg-white/10 ${className}`}
  >
    {(name || "?").trim().slice(0, 1)}
  </span>;
}
