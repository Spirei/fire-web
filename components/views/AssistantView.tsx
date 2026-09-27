"use client";

import DeferredAssistant from "@/components/DeferredAssistant";
import type { AssistantHistoryState } from "@/lib/assistantHistory";

export default function AssistantView({ page, symbol, userId, initialHistory, onNavigate }: {
  page: string;
  symbol?: string;
  userId: string;
  initialHistory: AssistantHistoryState | null;
  onNavigate: (path: string) => void;
}) {
  return (
    <section className="assistant-page">
      <DeferredAssistant embedded page={page} symbol={symbol} userId={userId} initialHistory={initialHistory} onNavigate={onNavigate} />
    </section>
  );
}
