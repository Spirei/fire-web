"use client";

import { useEffect } from "react";

const FALLBACK_ICON = "/favicon.ico";
let requestId = 0;

function applyLoadedIcon(src: string) {
  const currentRequest = ++requestId;
  if (!src || src === FALLBACK_ICON) {
    document.querySelector<HTMLLinkElement>('link[data-site-favicon="configured"]')?.remove();
    return;
  }
  const image = new Image();
  image.onload = () => {
    if (currentRequest !== requestId) return;
    let link = document.querySelector<HTMLLinkElement>('link[data-site-favicon="configured"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.dataset.siteFavicon = "configured";
      document.head.appendChild(link);
    }
    link.href = src;
  };
  image.src = src;
}

export default function SiteFavicon({ initialIcon }: { initialIcon?: string }) {
  useEffect(() => {
    applyLoadedIcon(initialIcon || FALLBACK_ICON);

    function refresh() {
      fetch("/api/settings/public", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => applyLoadedIcon(data?.settings?.ico || FALLBACK_ICON))
        .catch(() => {});
    }

    window.addEventListener("fire:settings-updated", refresh);
    return () => window.removeEventListener("fire:settings-updated", refresh);
  }, [initialIcon]);

  return null;
}
