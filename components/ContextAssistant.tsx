"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconArrowUp, IconChartPie, IconDatabaseSearch, IconMessageCircle, IconMinus, IconPlus, IconSparkles, IconX } from "@tabler/icons-react";
import type { StoredAssistantMessage } from "@/lib/assistantHistory";

type AssistantAction =
  | { type: "navigate"; label: string; path: string }
  | { type: "create_group"; label: string; name: string; createdAt: string; actionId: string }
  | { type: "assign_group"; label: string; groupId: string; groupName: string; recordIds: string[]; symbols: string[]; previous: Array<{ id: string; groupId: string }>; createdAt: string; actionId: string }
  | { type: "trade"; label: string; recordId: string; code: string; name: string; market?: string; side: "buy" | "sell"; qty: number; price: number; fees: number; createdAt: string; actionId: string };
type UndoAction =
  | { type: "delete_group"; groupId: string; actionId: string; createdAt: string }
  | { type: "restore_groups"; previous: Array<{ id: string; groupId: string }>; actionId: string; createdAt: string }
  | { type: "delete_order"; orderId: string; actionId: string; createdAt: string };
type Message = { role: "user" | "assistant"; content: string; action?: AssistantAction; actionStatus?: "running" | "done" | "error" | "uncertain"; undo?: UndoAction; undoStatus?: "running" | "error" | "uncertain" };

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

const MAX_SAVED_MESSAGES = 30;
const ACTION_TTL_MS = 15 * 60 * 1000;

function isActionExpired(action: AssistantAction) {
  if (action.type === "navigate") return false;
  return isTimestampExpired(action.createdAt);
}

function isTimestampExpired(value: string) {
  const createdAt = Date.parse(value);
  return !Number.isFinite(createdAt) || createdAt > Date.now() + 60_000 || Date.now() - createdAt > ACTION_TTL_MS;
}

function historyKey(userId: string) {
  return `fire:assistant:history:${userId}`;
}

export default function ContextAssistant({ page, symbol, userId, initialHistory, onNavigate }: { page: string; symbol?: string; userId: string; initialHistory: StoredAssistantMessage[]; onNavigate: (path: string) => void }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "saving" | "error">("idle");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [messages, setMessages] = useState<Message[]>(() => initialHistory as Message[]);
  const historyReady = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  const lastSavedHistory = useRef(JSON.stringify(initialHistory));
  const legacyHistoryPending = useRef(false);
  const actionsInFlight = useRef(new Set<number>());
  const actionOperationInFlight = useRef(false);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copy = PAGE_COPY[page] || { label: "当前页面", prompts: ["概览当前数据", "检查数据异常", "给我下一步建议"] };
  const contextLabel = useMemo(() => symbol ? `${copy.label} · ${symbol}` : copy.label, [copy.label, symbol]);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    // 一次性迁移旧版浏览器历史到服务端，随后清除本地的账户对话数据。
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey(userId)) || "[]") as Message[];
      if (messages.length === 0 && Array.isArray(saved) && saved.length > 0) {
        legacyHistoryPending.current = true;
        setMessages(saved.flatMap((item): Message[] => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string"
          ? [{ role: item.role, content: item.content.slice(0, 4000) }]
          : []).slice(-MAX_SAVED_MESSAGES));
      } else {
        localStorage.removeItem(historyKey(userId));
      }
    } catch {
      localStorage.removeItem(historyKey(userId));
    } finally {
      historyReady.current = true;
    }
    // initialHistory 由服务端首帧注入，只在登录用户变化时重新初始化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  useEffect(() => {
    if (!historyReady.current) return;
    const snapshot = messages.slice(-MAX_SAVED_MESSAGES);
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSavedHistory.current) return;
    setHistoryStatus("saving");
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch("/api/assistant/history", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: snapshot }) });
          if (!response.ok) throw new Error("history save failed");
          lastSavedHistory.current = serialized;
          setHistoryStatus("idle");
          if (legacyHistoryPending.current) {
            localStorage.removeItem(historyKey(userId));
            legacyHistoryPending.current = false;
          }
          return;
        } catch {
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
      setHistoryStatus("error");
    });
  }, [messages, userId, historyRetry]);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, open]);
  useEffect(() => {
    if (!open || minimized || !window.matchMedia("(min-width: 640px)").matches) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open, minimized]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function send(value: string) {
    const question = value.trim();
    if (!question || loading) return;
    const next = [...messages, { role: "user" as const, content: question }].slice(-MAX_SAVED_MESSAGES);
    const generation = requestGeneration.current;
    const controller = new AbortController();
    requestController.current = controller;
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const filter = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("filter") || "";
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context: { page, label: copy.label, symbol, filter } }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null) as { answer?: string; error?: string; action?: AssistantAction } | null;
      if (!response.ok) throw new Error(data?.error || "暂时无法回答");
      if (requestGeneration.current === generation) {
        setMessages((current) => [...current, { role: "assistant" as const, content: data?.answer || "暂时没有结果", action: data?.action }].slice(-MAX_SAVED_MESSAGES));
      }
    } catch (error) {
      if (requestGeneration.current === generation && !(error instanceof DOMException && error.name === "AbortError")) {
        setMessages((current) => [...current, { role: "assistant" as const, content: error instanceof Error ? error.message : "连接失败，请稍后重试" }].slice(-MAX_SAVED_MESSAGES));
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (requestGeneration.current === generation) setLoading(false);
    }
  }

  function startNewChat() {
    if (actionOperationInFlight.current) return;
    requestGeneration.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
    setMessages([]);
    setInput("");
    void fetch("/api/assistant/history", { method: "DELETE" });
  }

  function updateMessage(index: number, patch: Partial<Message>) {
    setMessages((current) => current.map((message, messageIndex) => messageIndex === index ? { ...message, ...patch } : message));
  }

  async function readApi(response: Response) {
    const data = await response.json().catch(() => null) as { code?: number; message?: string; data?: Record<string, unknown> } | null;
    if (!response.ok || (typeof data?.code === "number" && data.code !== 0)) throw new Error(data?.message || "操作失败");
    return data?.data || {};
  }

  async function executeAction(action: AssistantAction, index: number) {
    if (actionsInFlight.current.has(index) || actionOperationInFlight.current) return;
    if (isActionExpired(action)) {
      updateMessage(index, { action: undefined, actionStatus: undefined, content: `${messages[index]?.content || "操作预览"}\n\n预览已超过 15 分钟，请重新输入指令后再确认。` });
      return;
    }
    actionsInFlight.current.add(index);
    actionOperationInFlight.current = true;
    setActionBusy(true);
    if (action.type === "navigate") {
      updateMessage(index, { actionStatus: "done" });
      onNavigate(action.path);
      setOpen(false);
      actionsInFlight.current.delete(index);
      actionOperationInFlight.current = false;
      setActionBusy(false);
      return;
    }
    updateMessage(index, { actionStatus: "running" });
    try {
      let undo: UndoAction | undefined;
      if (action.type === "create_group") {
        const data = await readApi(await fetch("/api/assistant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
        const group = data.group as { id?: string } | undefined;
        if (group?.id) undo = { type: "delete_group", groupId: group.id, actionId: action.actionId.replace(/^aa-/, "au-"), createdAt: String(data.executedAt || new Date().toISOString()) };
        window.dispatchEvent(new Event("fire:watch-groups-updated"));
      } else if (action.type === "assign_group") {
        const data = await readApi(await fetch("/api/assistant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
        undo = { type: "restore_groups", previous: action.previous, actionId: action.actionId.replace(/^aa-/, "au-"), createdAt: String(data.executedAt || new Date().toISOString()) };
        window.dispatchEvent(new Event("fire:records-updated"));
        window.dispatchEvent(new Event("fire:watch-groups-updated"));
      } else if (action.type === "trade") {
        const data = await readApi(await fetch("/api/assistant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
        const order = (data.order || (data as { order?: { id?: string } }).order) as { id?: string } | undefined;
        if (order?.id) undo = { type: "delete_order", orderId: order.id, actionId: action.actionId.replace(/^aa-/, "au-"), createdAt: String(data.executedAt || new Date().toISOString()) };
        window.dispatchEvent(new Event("fire:records-updated"));
        window.dispatchEvent(new Event("fire:orders-updated"));
      }
      updateMessage(index, { actionStatus: "done", undo });
    } catch (error) {
      updateMessage(index, { actionStatus: "error", content: `${messages[index]?.content || "操作"}\n\n${error instanceof Error ? error.message : "操作失败"}` });
    } finally {
      actionsInFlight.current.delete(index);
      actionOperationInFlight.current = false;
      setActionBusy(false);
    }
  }

  async function undoAction(undo: UndoAction, index: number) {
    if (actionsInFlight.current.has(index) || actionOperationInFlight.current) return;
    if (isTimestampExpired(undo.createdAt)) {
      updateMessage(index, { undo: undefined, undoStatus: undefined, content: `${messages[index]?.content || "操作"}\n\n撤销窗口已结束。` });
      return;
    }
    actionsInFlight.current.add(index);
    actionOperationInFlight.current = true;
    setActionBusy(true);
    updateMessage(index, { undoStatus: "running" });
    try {
      await readApi(await fetch("/api/assistant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...undo, type: `undo_${undo.type}` }) }));
      if (undo.type === "delete_group") {
        window.dispatchEvent(new Event("fire:watch-groups-updated"));
      } else if (undo.type === "restore_groups") {
        window.dispatchEvent(new Event("fire:records-updated"));
        window.dispatchEvent(new Event("fire:watch-groups-updated"));
      } else {
        window.dispatchEvent(new Event("fire:records-updated"));
        window.dispatchEvent(new Event("fire:orders-updated"));
      }
      updateMessage(index, { actionStatus: undefined, action: undefined, undo: undefined, undoStatus: undefined, content: `${messages[index]?.content || "操作"}\n\n已撤销。` });
    } catch (error) {
      updateMessage(index, { undoStatus: "error", content: `${messages[index]?.content || "操作"}\n\n撤销失败：${error instanceof Error ? error.message : "请稍后重试"}` });
    } finally {
      actionsInFlight.current.delete(index);
      actionOperationInFlight.current = false;
      setActionBusy(false);
    }
  }

  function actionSummary(action: AssistantAction) {
    if (action.type === "trade") return `${action.name}（${action.market ? `${action.market}:` : ""}${action.code}） · ${action.side === "buy" ? "买入" : "卖出"} ${action.qty} 股 × ${action.price} · 预计 ${(action.qty * action.price + (action.side === "buy" ? action.fees : -action.fees)).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
    if (action.type === "assign_group") return `${action.symbols.join("、")} → ${action.groupName}`;
    if (action.type === "create_group") return `新分组：${action.name}`;
    return action.label;
  }

  function actionExpired(action: AssistantAction) {
    return isActionExpired(action);
  }

  if (!mounted) return null;
  return createPortal(
    <>
      {!open && (
        <button type="button" onClick={() => { setOpen(true); setMinimized(false); }} className="assistant-launcher fixed bottom-5 right-5 z-[90] flex h-12 w-12 items-center justify-center rounded-full border border-[#5eead4]/45 bg-gradient-to-br from-[#14b8a6] to-[#0f766e] text-white shadow-[0_12px_34px_rgba(13,148,136,.32)] transition-all duration-200 hover:-translate-y-0.5 hover:from-[#2dd4bf] hover:to-[#0d9488] hover:shadow-[0_14px_38px_rgba(13,148,136,.4)] active:scale-95 sm:bottom-7 sm:right-7 sm:h-14 sm:w-14" aria-label="打开账户助手" title="账户助手">
          <IconSparkles size={23} stroke={1.8} />
        </button>
      )}
      {open && (
        <div onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }} className="assistant-layer fixed inset-0 z-[100] flex items-end justify-end bg-black/20 sm:pointer-events-none sm:bg-transparent">
          <section role="dialog" aria-modal="true" aria-label="账户助手" className={`assistant-panel pointer-events-auto flex w-full flex-col overflow-hidden border border-edge bg-white shadow-[0_24px_80px_rgba(0,0,0,.25)] dark:bg-[#121722] ${minimized ? "h-[68px] sm:w-[320px]" : "h-[72dvh] rounded-t-[22px] sm:mb-7 sm:mr-7 sm:h-[min(680px,calc(100dvh-112px))] sm:w-[420px] sm:rounded-[22px]"}`}>
            <header className="flex min-h-[68px] items-center gap-3 border-b border-edge px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#171b24] text-white dark:bg-white dark:text-[#11151d]"><IconSparkles size={18} /></span>
              <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-ink">账户助手</div><div className="truncate text-[11px] text-muted">正在查看：{contextLabel}</div></div>
              {messages.length > 0 && <button type="button" disabled={actionBusy} onClick={startNewChat} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-35" aria-label="开始新对话" title={actionBusy ? "操作完成后可开始新对话" : "开始新对话"}><IconPlus size={18} /></button>}
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
                    {messages.map((message, index) => <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-[#171b24] text-white dark:bg-white dark:text-[#11151d]" : "bg-bg-gray text-ink"}`}>{displayText(message.content)}{message.action && <div className="mt-3 rounded-xl border border-edge bg-white/80 p-3 dark:bg-white/[.05]"><div className="text-xs font-medium text-ink">{actionSummary(message.action)}</div><button type="button" disabled={actionBusy || message.actionStatus === "running" || message.actionStatus === "done" || actionExpired(message.action)} onClick={() => void executeAction(message.action as AssistantAction, index)} className="mt-3 w-full rounded-xl border border-edge-strong bg-white px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-brand-hover disabled:opacity-55 dark:bg-[#1c222d]">{message.actionStatus === "running" ? "处理中…" : message.actionStatus === "done" ? "已完成" : message.actionStatus === "uncertain" ? "安全重试并核对" : actionExpired(message.action) ? "预览已过期，请重新输入" : message.actionStatus === "error" ? "重试" : message.action.label}</button>{message.actionStatus === "uncertain" && <p className="mt-2 text-[11px] leading-5 text-muted">页面曾在执行过程中中断。安全重试会复用原操作标识：已成功则只返回原结果，未成功才执行。</p>}{message.actionStatus === "done" && message.undo && <button type="button" disabled={actionBusy || message.undoStatus === "running" || isTimestampExpired(message.undo.createdAt)} onClick={() => void undoAction(message.undo as UndoAction, index)} className="mt-2 w-full text-center text-[11px] text-muted hover:text-ink disabled:opacity-35">{message.undoStatus === "running" ? "撤销中…" : isTimestampExpired(message.undo.createdAt) ? "撤销窗口已结束" : message.undoStatus === "uncertain" ? "安全重试撤销" : message.undoStatus === "error" ? "重试撤销" : "撤销操作"}</button>}{message.undoStatus === "uncertain" && !isTimestampExpired(message.undo?.createdAt || "") && <p className="mt-1 text-[11px] leading-5 text-muted">撤销响应曾中断，再次点击不会重复撤销。</p>}</div>}</div></div>)}
                    {loading && <div className="flex justify-start"><div className="flex items-center gap-1 rounded-2xl bg-bg-gray px-4 py-3"><i className="assistant-dot" /><i className="assistant-dot [animation-delay:120ms]" /><i className="assistant-dot [animation-delay:240ms]" /></div></div>}
                    <div ref={endRef} />
                  </div>
                )}
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void send(input); }} className="border-t border-edge p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
                <div className="flex items-end gap-2 rounded-[20px] border border-edge-strong bg-bg-gray p-2 pl-4">
                  <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(input); } }} rows={1} maxLength={1200} placeholder={`问问${copy.label}…`} className="max-h-28 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-sm text-ink placeholder:text-faint" />
                  <button type="submit" disabled={!input.trim() || loading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#171b24] text-white transition-all disabled:opacity-30 dark:bg-white dark:text-[#11151d]" aria-label="发送"><IconArrowUp size={19} /></button>
                </div>
                <p className="mt-2 truncate text-center text-[10px] text-faint" title="示例：打开美股自选；创建科技分组；把 AAPL、NVDA 加入科技分组；买入 AAPL 10 股 200">可直接说：筛选市场、创建或整理分组、录入买卖</p>
                {historyStatus === "error" ? <button type="button" onClick={() => setHistoryRetry((value) => value + 1)} className="mt-2 w-full text-center text-[10px] text-muted hover:text-ink">对话保存失败，点击重试</button> : <p className="mt-2 text-center text-[10px] text-faint">{historyStatus === "saving" ? "正在保存对话…" : "账户数据仅用于本次回答，请核对关键金额与行情时间"}</p>}
              </form>
            </>}
          </section>
        </div>
      )}
    </>, document.body
  );
}
