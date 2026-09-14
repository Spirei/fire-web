"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconArrowUp, IconChartPie, IconDatabaseSearch, IconMessageCircle, IconMinus, IconSparkles, IconX } from "@tabler/icons-react";

type Message = { role: "user" | "assistant"; content: string };

const PAGE_COPY: Record<string, { label: string; prompts: string[] }> = {
  holdings: { label: "账户资产", prompts: ["概览我的持仓", "检查持仓数据异常", "我的持仓分布如何？"] },
  assets: { label: "资产分析", prompts: ["分析我的资产结构", "有哪些集中度风险？", "检查收益数据异常"] },
  pnl: { label: "资产总盈亏", prompts: ["总结总盈亏", "哪些持仓贡献最大？", "检查盈亏数据异常"] },
  watchlist: { label: "自选股", prompts: ["概览我的自选股", "如何整理这些分组？", "检查缺失行情"] },
  fire: { label: "FIRE", prompts: ["分析我的 FIRE 进度", "下一步应关注什么？", "检查计算口径"] },
  earnings: { label: "财报日历", prompts: ["整理近期财报关注点", "我的持仓有哪些财报？", "检查日历数据"] },
  cards: { label: "卡面库", prompts: ["检查卡面数据异常", "概览我的银行卡", "如何整理卡面？"] },
  library: { label: "素材库", prompts: ["检查失效素材", "概览素材状态", "给出整理建议"] }
};

function displayText(text: string) {
  return text.split("\n").map((line, index) => <span key={`${index}-${line}`} className="block min-h-[1.35em]">{line}</span>);
}

export default function ContextAssistant({ page, symbol }: { page: string; symbol?: string }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const copy = PAGE_COPY[page] || { label: "当前页面", prompts: ["概览当前数据", "检查数据异常", "给我下一步建议"] };
  const contextLabel = useMemo(() => symbol ? `${copy.label} · ${symbol}` : copy.label, [copy.label, symbol]);

  useEffect(() => setMounted(true), []);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, open]);

  async function send(value: string) {
    const question = value.trim();
    if (!question || loading) return;
    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const filter = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("filter") || "";
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context: { page, label: copy.label, symbol, filter } })
      });
      const data = await response.json().catch(() => null) as { answer?: string; error?: string } | null;
      if (!response.ok) throw new Error(data?.error || "暂时无法回答");
      setMessages((current) => [...current, { role: "assistant", content: data?.answer || "暂时没有结果" }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "连接失败，请稍后重试" }]);
    } finally {
      setLoading(false);
    }
  }

  if (!mounted) return null;
  return createPortal(
    <>
      {!open && (
        <button type="button" onClick={() => { setOpen(true); setMinimized(false); }} className="assistant-launcher fixed bottom-5 right-5 z-[90] flex h-12 w-12 items-center justify-center rounded-full border border-edge-strong bg-[#171b24] text-white shadow-[0_12px_36px_rgba(0,0,0,.22)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#252b36] active:scale-95 sm:bottom-7 sm:right-7 sm:h-14 sm:w-14" aria-label="打开账户助手" title="账户助手">
          <IconSparkles size={23} stroke={1.8} />
        </button>
      )}
      {open && (
        <div className="assistant-layer fixed inset-0 z-[100] flex items-end justify-end bg-black/20 sm:pointer-events-none sm:bg-transparent">
          <section className={`assistant-panel pointer-events-auto flex w-full flex-col overflow-hidden border border-edge bg-white shadow-[0_24px_80px_rgba(0,0,0,.25)] dark:bg-[#121722] ${minimized ? "h-[68px] sm:w-[320px]" : "h-[72dvh] sm:mb-7 sm:mr-7 sm:h-[min(680px,calc(100dvh-112px))] sm:w-[420px] sm:rounded-[22px]"}`}>
            <header className="flex min-h-[68px] items-center gap-3 border-b border-edge px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#171b24] text-white dark:bg-white dark:text-[#11151d]"><IconSparkles size={18} /></span>
              <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-ink">账户助手</div><div className="truncate text-[11px] text-muted">正在查看：{contextLabel}</div></div>
              <button type="button" onClick={() => setMinimized((value) => !value)} className="hidden h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-bg-gray sm:flex" aria-label={minimized ? "展开" : "最小化"}><IconMinus size={18} /></button>
              <button type="button" onClick={() => setOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-bg-gray" aria-label="关闭"><IconX size={18} /></button>
            </header>
            {!minimized && <>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {messages.length === 0 ? (
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight text-ink">想了解什么？</h2>
                    <p className="mt-2 text-sm leading-6 text-muted">我会结合当前页面和你的账户数据回答，并指出下一步可以做什么。</p>
                    <div className="mt-6 grid gap-2.5">
                      {copy.prompts.map((prompt, index) => (
                        <button key={prompt} type="button" onClick={() => void send(prompt)} className="flex items-center gap-3 rounded-2xl border border-edge bg-bg-gray/60 px-4 py-3.5 text-left text-sm text-ink transition-colors hover:bg-brand-hover">
                          {index === 0 ? <IconChartPie size={18} className="text-muted" /> : index === 1 ? <IconDatabaseSearch size={18} className="text-muted" /> : <IconMessageCircle size={18} className="text-muted" />}
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages.map((message, index) => <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-[#171b24] text-white dark:bg-white dark:text-[#11151d]" : "bg-bg-gray text-ink"}`}>{displayText(message.content)}</div></div>)}
                    {loading && <div className="flex justify-start"><div className="flex items-center gap-1 rounded-2xl bg-bg-gray px-4 py-3"><i className="assistant-dot" /><i className="assistant-dot [animation-delay:120ms]" /><i className="assistant-dot [animation-delay:240ms]" /></div></div>}
                    <div ref={endRef} />
                  </div>
                )}
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void send(input); }} className="border-t border-edge p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
                <div className="flex items-end gap-2 rounded-[20px] border border-edge-strong bg-bg-gray p-2 pl-4">
                  <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(input); } }} rows={1} maxLength={1200} placeholder={`问问${copy.label}…`} className="max-h-28 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-sm text-ink placeholder:text-faint" />
                  <button type="submit" disabled={!input.trim() || loading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#171b24] text-white transition-all disabled:opacity-30 dark:bg-white dark:text-[#11151d]" aria-label="发送"><IconArrowUp size={19} /></button>
                </div>
                <p className="mt-2 text-center text-[10px] text-faint">账户数据仅用于本次回答，请核对关键金额与行情时间</p>
              </form>
            </>}
          </section>
        </div>
      )}
    </>, document.body
  );
}
