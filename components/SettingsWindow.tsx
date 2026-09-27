"use client";

import type { ReactNode } from "react";

/** 设置是页面，不是可拖出视口的桌面窗口。 */
export default function SettingsWindow({ children }: { children: ReactNode; version: string }) {
  return <div className="sv-win-root sv-orca sv-center w-full">
    <div className="sw-window flex h-full min-h-0 overflow-hidden">{children}</div>
  </div>;
}
