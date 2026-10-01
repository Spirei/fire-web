"use client";

import { useEffect } from "react";

/** PWA Service Worker 注册：安装后 Chrome 地址栏出现「安装应用 / 在应用中打开」 */
export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // Dev chunks change in place; an old PWA worker must not restore stale HTML/CSS after HMR.
      void navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(registration => {
        const script = registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL;
        return script === new URL("/sw.js", location.origin).href ? registration.unregister() : false;
      }))).catch(() => {});
      return;
    }
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      /* 非安全上下文（如局域网 IP http）或浏览器不支持时静默失败 */
    });
  }, []);
  return null;
}
