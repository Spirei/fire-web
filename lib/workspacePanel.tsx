"use client";

import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { ReadonlyURLSearchParams, useSearchParams } from "next/navigation";

export const WorkspaceActiveContext = createContext(true);
export const WorkspacePathContext = createContext<string | null>(null);
export const WorkspaceQueryContext = createContext<string | null>(null);

export function useWorkspaceActive() {
  return useContext(WorkspaceActiveContext);
}

export function useWorkspaceLocationGuard() {
  const active = useContext(WorkspaceActiveContext), path = useContext(WorkspacePathContext);
  const latest = useRef({ active, path });
  latest.current = { active, path };
  return useCallback(() => {
    const { active, path } = latest.current;
    return active && (!path || window.location.pathname === path || window.location.pathname.startsWith(path + "/"));
  }, []);
}

/** Cached workspaces retain their own query while another workspace owns the address bar. */
export function useWorkspaceSearchParams() {
  const current = useSearchParams();
  const active = useContext(WorkspaceActiveContext);
  const saved = useContext(WorkspaceQueryContext);
  // A lazy view may finish downloading after the user leaves. Its first mount
  // must use that view's saved query, not the currently visible page's query.
  const initial = useMemo(() => saved === null ? current : new ReadonlyURLSearchParams(saved), [saved, current]);
  const snapshot = useRef(active ? current : initial);
  if (active) snapshot.current = current;
  return snapshot.current;
}
