"use client";

import { useEffect } from "react";

export default function SiteBg() {
  useEffect(() => {
    function apply() {
      fetch("/api/settings/public")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const bg = data?.settings?.homepageBg;
          document.documentElement.style.setProperty("--site-bg-image", bg ? `url("${bg}")` : "none");
        })
        .catch(() => {});
    }
    apply();
    window.addEventListener("fire:settings-updated", apply);
    return () => window.removeEventListener("fire:settings-updated", apply);
  }, []);

  return null;
}
