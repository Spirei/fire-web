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
    <section className="assistant-page">
      <ContextAssistant embedded page={page} symbol={symbol} userId={userId} initialHistory={initialHistory} onNavigate={onNavigate} />
    </section>
  );
}
