"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function SiteBg() {
  const pathname = usePathname();
  useEffect(() => {
    let active = true;
    if (pathname === "/") {
      document.documentElement.style.setProperty("--site-bg-image", "none");
      return;
    }
    function apply() {
      fetch("/api/settings/public")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!active) return;
          const bg = data?.settings?.homepageBg;
          if (!bg) {
            document.documentElement.style.setProperty("--site-bg-image", "none");
            return;
          }
          const probe = new Image();
          probe.onload = () => { if (active) document.documentElement.style.setProperty("--site-bg-image", `url("${bg}")`); };
          probe.onerror = () => { if (active) document.documentElement.style.setProperty("--site-bg-image", "none"); };
          probe.src = bg;
        })
        .catch(() => {});
    }
    apply();
    window.addEventListener("fire:settings-updated", apply);
    return () => { active = false; window.removeEventListener("fire:settings-updated", apply); };
  }, [pathname]);

  return null;
}
