"use client";

import { useEffect } from "react";

export default function SiteBg() {
  useEffect(() => {
    function apply() {
      fetch("/api/settings/public")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const bg = data?.settings?.homepageBg;
          if (!bg) {
            document.documentElement.style.setProperty("--site-bg-image", "none");
            return;
          }
          const probe = new Image();
          probe.onload = () => document.documentElement.style.setProperty("--site-bg-image", `url("${bg}")`);
          probe.onerror = () => document.documentElement.style.setProperty("--site-bg-image", "none");
          probe.src = bg;
        })
        .catch(() => {});
    }
    apply();
    window.addEventListener("fire:settings-updated", apply);
    return () => window.removeEventListener("fire:settings-updated", apply);
  }, []);

  return null;
}
