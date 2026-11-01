"use client";

import { Component, memo, type ReactNode } from "react";
import { WorkspaceActiveContext, WorkspacePathContext, WorkspaceQueryContext } from "@/lib/workspacePanel";

type BoundaryProps = { children: ReactNode; fallback?: ReactNode; active?: boolean; onRetry?: () => Promise<void> };
export class WorkspaceBoundary extends Component<BoundaryProps, { failed: boolean; retrying: boolean }> {
  state = { failed: false, retrying: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && this.props.active && !previous.active && this.props.onRetry) void this.retry();
  }
  retry = async () => {
    if (this.state.retrying) return;
    if (!this.props.onRetry) { window.location.reload(); return; }
    this.setState({ retrying: true });
    try { await this.props.onRetry(); }
    catch { /* Keep the failed page and its retry control available. */ }
    finally { this.setState({ retrying: false }); }
  };
  render() {
    if (this.state.failed) return this.props.fallback ?? <div className="workspace-load-error" role="alert">
      <p>这个页面未能打开</p>
      {!this.props.onRetry && <p>可以先切换到其他页面，或重新加载当前页面。</p>}
      <button type="button" disabled={this.state.retrying} onClick={this.retry}>{this.state.retrying ? "正在重试…" : this.props.onRetry ? "重试" : "重新加载"}</button>
    </div>;
    return this.props.children;
  }
}

export function WorkspaceLoading() {
  return <div className="workspace-view-loading" role="status" aria-label="加载页面">
    <div aria-hidden="true"><span /><span /><span /></div>
  </div>;
}

const WorkspacePanel = memo(function WorkspacePanel({ active, path, query, children, onRetry }: { active: boolean; path: string; query: string; children: ReactNode; onRetry?: () => Promise<void> }) {
  return <WorkspaceActiveContext.Provider value={active}><WorkspacePathContext.Provider value={path}><WorkspaceQueryContext.Provider value={query}><WorkspaceBoundary active={active} onRetry={onRetry}>{children}</WorkspaceBoundary></WorkspaceQueryContext.Provider></WorkspacePathContext.Provider></WorkspaceActiveContext.Provider>;
});

export default WorkspacePanel;
