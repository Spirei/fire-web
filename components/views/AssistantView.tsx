"use client";

import ContextAssistant from "@/components/ContextAssistant";
import type { AssistantHistoryState } from "@/lib/assistantHistory";

export default function AssistantView({ page, symbol, userId, initialHistory, onNavigate }: {
  page: string;
  symbol?: string;
  userId: string;
  initialHistory: AssistantHistoryState;
  onNavigate: (path: string) => void;
}) {
  return (
    <section className="assistant-page space-y-5">
      <div className="flex items-end justify-between gap-5">
        <div>
          <p className="text-xs font-medium text-muted">AI 工作台</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink dark:text-white">智能助手</h1>
          <p className="mt-1.5 text-sm text-muted">管理对话、模型、记忆与数据范围，也可以直接分析图片和账户数据。</p>
        </div>
        <a href="/settings?sub=stocks&anchor=model" className="hidden rounded-xl border border-edge bg-white px-4 py-2 text-xs font-semibold text-ink transition-colors hover:bg-bg-gray dark:border-white/10 dark:bg-white/[.04] dark:text-white/80 dark:hover:bg-white/[.08] sm:inline-flex">模型服务</a>
      </div>
      <ContextAssistant embedded page={page} symbol={symbol} userId={userId} initialHistory={initialHistory} onNavigate={onNavigate} />
    </section>
  );
}
