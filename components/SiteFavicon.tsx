"use client";

import { useEffect } from "react";

const FALLBACK_ICON = "/site-icon.svg";

function applyIcon(src: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][href^="data:image/png;base64,"], link[rel="icon"][href^="/api/site-favicon"], link[rel="icon"][href="/site-icon.svg"], link[data-site-favicon="configured"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.siteFavicon = "configured";
    document.head.appendChild(link);
  }
  // 自定义原图只用于设置页编辑；标签图标由服务端缩成 64px，避免首页拉取大图。
  const href = src.startsWith("/uploads/ico/") ? `/api/site-favicon?v=${encodeURIComponent(src)}` : src === "/favicon.ico" ? FALLBACK_ICON : src || FALLBACK_ICON;
  if (link.getAttribute("href") !== href) link.href = href;
}

export default function SiteFavicon() {
  useEffect(() => {
    function refresh() {
      fetch("/api/settings/public", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => applyIcon(data?.settings?.ico || FALLBACK_ICON))
        .catch(() => {});
    }

    window.addEventListener("fire:settings-updated", refresh);
    return () => window.removeEventListener("fire:settings-updated", refresh);
  }, []);

  return null;
}
