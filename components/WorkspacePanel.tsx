"use client";

import { Component, memo, type ReactNode } from "react";
import { WorkspaceActiveContext, WorkspacePathContext, WorkspaceQueryContext } from "@/lib/workspacePanel";

export class WorkspaceBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return this.props.fallback ?? <div className="workspace-load-error" role="alert">
      <p>这个页面未能打开</p>
      <p>可以先切换到其他页面，或重新加载当前页面。</p>
      <button type="button" onClick={() => window.location.reload()}>重新加载</button>
    </div>;
    return this.props.children;
  }
}

export function WorkspaceLoading() {
  return <div className="workspace-view-loading" role="status" aria-label="正在打开页面">
    <p>正在打开…</p>
    <div aria-hidden="true"><span /><span /><span /></div>
  </div>;
}

const WorkspacePanel = memo(function WorkspacePanel({ active, path, query, children }: { active: boolean; path: string; query: string; children: ReactNode }) {
  return <WorkspaceActiveContext.Provider value={active}><WorkspacePathContext.Provider value={path}><WorkspaceQueryContext.Provider value={query}><WorkspaceBoundary>{children}</WorkspaceBoundary></WorkspaceQueryContext.Provider></WorkspacePathContext.Provider></WorkspaceActiveContext.Provider>;
});

export default WorkspacePanel;
