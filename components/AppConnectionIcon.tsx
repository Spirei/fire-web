"use client";

import { useState } from "react";
import { DEFAULT_APP_ICON } from "@/lib/appConnectionBrand";

export default function AppConnectionIcon({ src, small = false, site = false }: { src: string; small?: boolean; site?: boolean }) {
  const [failedSrc, setFailedSrc] = useState("");
  const fallback = site ? "/site-icon.svg" : DEFAULT_APP_ICON;
  return <span className={`app-connection-icon${small ? " is-small" : ""}${site ? " is-site" : ""}`} aria-hidden="true">
    <img src={failedSrc === src ? fallback : src} alt="" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
  </span>;
}
