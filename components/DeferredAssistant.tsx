"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { AssistantHistoryState } from "@/lib/assistantHistory";
import { sharedRead } from "@/lib/sharedRead";

const ContextAssistant = dynamic(() => import("@/components/ContextAssistant"));

/** 历史读取完成前不挂载助手，避免把尚未读取的会话当作空会话保存。 */
export default function DeferredAssistant(props: {
  page: string;
  symbol?: string;
  userId: string;
  initialHistory: AssistantHistoryState | null;
  onNavigate: (path: string) => void;
  embedded?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ userId: string; history: AssistantHistoryState } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const history = props.initialHistory ?? (loaded?.userId === props.userId ? loaded.history : null);
  useEffect(() => {
    if (history) return;
    let cancelled = false;
    setError(false);
    void sharedRead("/api/assistant/history").then(async response => {
      if (!response.ok) throw new Error("history unavailable");
      const data = await response.json() as AssistantHistoryState;
      if (typeof data.activeId !== "string" || !Array.isArray(data.conversations)) throw new Error("invalid history");
      if (!cancelled) setLoaded({ userId: props.userId, history: data });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [history, props.userId, retry]);

  if (!history) return error ? <div className={props.embedded ? "p-6 text-sm text-muted" : "fixed bottom-7 right-7 z-[110] rounded-2xl border border-edge bg-white p-3 text-sm text-ink"} role="status">
    会话读取失败 <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>重试</button>
  </div> : props.embedded ? <div className="p-6 text-sm text-muted" role="status">读取会话…</div> : null;
  return <ContextAssistant {...props} key={props.userId} initialHistory={history} />;
}
