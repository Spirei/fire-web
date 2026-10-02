"use client";

import { useEffect, useState } from "react";
import { useWorkspaceActive } from "./workspacePanel";

/** Retained pages do background work only while both the workspace and document are visible. */
export function useWorkspaceForeground() {
  const active = useWorkspaceActive();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);
  return active && visible;
}
