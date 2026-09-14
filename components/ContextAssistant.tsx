"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { IconArrowUp, IconChartPie, IconDatabaseSearch, IconHistory, IconMessageCircle, IconPlus, IconRefresh, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import type { AssistantHistoryState, StoredAssistantConversation, StoredAssistantMessage } from "@/lib/assistantHistory";

type AssistantAction =
  | { type: "navigate"; label: string; path: string }
  | { type: "create_group"; label: string; name: string; createdAt: string; actionId: string }
  | { type: "assign_group"; label: string; groupId: string; groupName: string; recordIds: string[]; symbols: string[]; previous: Array<{ id: string; groupId: string }>; createdAt: string; actionId: string }
  | { type: "trade"; label: string; recordId: string; code: string; name: string; market?: string; side: "buy" | "sell"; qty: number; price: number; fees: number; createdAt: string; actionId: string };
type UndoAction =
  | { type: "delete_group"; groupId: string; actionId: string; createdAt: string }
  | { type: "restore_groups"; previous: Array<{ id: string; groupId: string }>; actionId: string; createdAt: string }
  | { type: "delete_order"; orderId: string; actionId: string; createdAt: string };
type Message = { role: "user" | "assistant"; content: string; responseError?: boolean; retryQuestion?: string; action?: AssistantAction; actionStatus?: "running" | "done" | "error" | "uncertain"; undo?: UndoAction; undoStatus?: "running" | "error" | "uncertain" };
type PendingImage = { id: string; name: string; dataUrl: string; size: number };

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

function inlineText(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-black/[.055] px-1 py-0.5 font-mono text-[.88em]">{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    return <span key={index}>{part}</span>;
  });
}

function displayText(text: string) {
  return <div className="space-y-1.5">{text.split("\n").map((raw, index) => {
    const line = raw.trim();
    if (!line) return <div key={index} className="h-1" />;
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) return <div key={index} className="pt-1 font-semibold text-ink">{inlineText(heading[1])}</div>;
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) return <div key={index} className="flex gap-2"><span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[#6c9f98]" /><span className="min-w-0">{inlineText(bullet[1])}</span></div>;
    const numbered = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (numbered) return <div key={index} className="flex gap-2"><span className="min-w-4 shrink-0 font-medium text-muted">{numbered[1]}.</span><span className="min-w-0">{inlineText(numbered[2])}</span></div>;
    return <div key={index}>{inlineText(line)}</div>;
  })}</div>;
}

function AssistantGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M10.7 3.15c.38-1.53 2.55-1.53 2.93 0l.5 2.02a6.15 6.15 0 0 0 4.48 4.48l2.02.5c1.53.38 1.53 2.55 0 2.93l-2.02.5a6.15 6.15 0 0 0-4.48 4.48l-.5 2.02c-.38 1.53-2.55 1.53-2.93 0l-.5-2.02a6.15 6.15 0 0 0-4.48-4.48l-2.02-.5c-1.53-.38-1.53-2.55 0-2.93l2.02-.5a6.15 6.15 0 0 0 4.48-4.48l.5-2.02Z" fill="currentColor" />
      <path d="M18.3 1.65c.17-.7 1.16-.7 1.33 0l.12.47c.2.82.84 1.46 1.66 1.66l.47.12c.7.17.7 1.16 0 1.33l-.47.12c-.82.2-1.46.84-1.66 1.66l-.12.47c-.17.7-1.16.7-1.33 0l-.12-.47a2.3 2.3 0 0 0-1.66-1.66l-.47-.12c-.7-.17-.7-1.16 0-1.33l.47-.12c.82-.2 1.46-.84 1.66-1.66l.12-.47Z" fill="#22e6bd" />
    </svg>
  );
}

const MAX_SAVED_MESSAGES = 30;
const ACTION_TTL_MS = 15 * 60 * 1000;
const FLOATING_MARGIN = 12;
const MAX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;

type FloatingPosition = { x: number; y: number };
type FloatingTarget = "launcher" | "panel";

function floatingPositionKey(userId: string, target: FloatingTarget) {
  return `fire:assistant:${target}-position:${userId}`;
}

function readPersistentPreference(key: string) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
  } catch { /* Cookie fallback below. */ }
  const cookieName = encodeURIComponent(key);
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${cookieName}=`));
  return match ? decodeURIComponent(match.slice(cookieName.length + 1)) : null;
}

function writePersistentPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return;
  } catch {
    try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  }
  document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function clampFloatingPosition(position: FloatingPosition, width: number, height: number) {
  const horizontalMargin = width + FLOATING_MARGIN * 2 <= window.innerWidth ? FLOATING_MARGIN : 0;
  const verticalMargin = height + FLOATING_MARGIN * 2 <= window.innerHeight ? FLOATING_MARGIN : 0;
  return {
    x: Math.min(Math.max(horizontalMargin, position.x), Math.max(horizontalMargin, window.innerWidth - width - horizontalMargin)),
    y: Math.min(Math.max(verticalMargin, position.y), Math.max(verticalMargin, window.innerHeight - height - verticalMargin))
  };
}

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

function newConversationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ac-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function conversationTime(value: string) {
  return value ? value.replace("T", " ").slice(5, 16) : "";
}

export default function ContextAssistant({ page, symbol, userId, initialHistory, onNavigate }: { page: string; symbol?: string; userId: string; initialHistory: AssistantHistoryState; onNavigate: (path: string) => void }) {
  const initialConversation = initialHistory.conversations.find((item) => item.id === initialHistory.activeId) || initialHistory.conversations[0];
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [pinned, setPinned] = useState(false);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [previewImage, setPreviewImage] = useState<PendingImage | null>(null);
  const pendingImageBytesRef = useRef(0);
  const pendingImageSequenceRef = useRef(0);
  const [attachmentError, setAttachmentError] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "saving" | "error">("idle");
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [conversationId, setConversationId] = useState(initialConversation?.id || "");
  const [conversations, setConversations] = useState<StoredAssistantConversation[]>(initialHistory.conversations);
  const [messages, setMessages] = useState<Message[]>(() => (initialConversation?.messages || []) as Message[]);
  const historyReady = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  const lastSavedHistory = useRef(new Map(initialHistory.conversations.map((item) => [item.id, JSON.stringify(item.messages)])));
  const legacyHistoryPending = useRef(false);
  const deletedConversationIds = useRef(new Set<string>());
  const actionsInFlight = useRef(new Set<number>());
  const actionOperationInFlight = useRef(false);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [launcherPosition, setLauncherPosition] = useState<FloatingPosition | null>(null);
  const [panelPosition, setPanelPosition] = useState<FloatingPosition | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressLauncherClick = useRef(false);
  const copy = PAGE_COPY[page] || { label: "当前页面", prompts: ["概览当前数据", "检查数据异常", "给我下一步建议"] };

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setPinned(readPersistentPreference(`fire:assistant:pinned:${userId}`) === "1");
  }, [userId]);
  useEffect(() => {
    const restore = (target: FloatingTarget, element: HTMLElement | null, setter: (value: FloatingPosition) => void) => {
      if (!element) return;
      try {
        const saved = JSON.parse(readPersistentPreference(floatingPositionKey(userId, target)) || "null") as FloatingPosition | null;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setter(clampFloatingPosition(saved, element.offsetWidth, element.offsetHeight));
      } catch {
        try { localStorage.removeItem(floatingPositionKey(userId, target)); } catch { /* Invalid or unavailable storage is ignored. */ }
      }
    };
    restore("launcher", launcherRef.current, setLauncherPosition);
    restore("panel", panelRef.current, setPanelPosition);
  }, [mounted, open, userId]);
  useEffect(() => {
    const clampVisibleItems = () => {
      if (launcherPosition && launcherRef.current) setLauncherPosition(clampFloatingPosition(launcherPosition, launcherRef.current.offsetWidth, launcherRef.current.offsetHeight));
      if (panelPosition && panelRef.current) setPanelPosition(clampFloatingPosition(panelPosition, panelRef.current.offsetWidth, panelRef.current.offsetHeight));
    };
    window.addEventListener("resize", clampVisibleItems);
    return () => window.removeEventListener("resize", clampVisibleItems);
  }, [launcherPosition, panelPosition]);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  useEffect(() => {
    // 一次性迁移旧版浏览器历史到服务端，随后清除本地的账户对话数据。
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey(userId)) || "[]") as Message[];
      if (conversations.length === 0 && messages.length === 0 && Array.isArray(saved) && saved.length > 0) {
        legacyHistoryPending.current = true;
        setConversationId(newConversationId());
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
    if (!conversationId || messages.length === 0) return;
    const snapshot = messages.slice(-MAX_SAVED_MESSAGES);
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSavedHistory.current.get(conversationId)) return;
    setConversations((current) => {
      const now = new Date().toISOString();
      const title = snapshot.find((message) => message.role === "user")?.content.trim().replace(/\s+/g, " ").slice(0, 36) || "新对话";
      const existing = current.find((item) => item.id === conversationId);
      const next: StoredAssistantConversation = { id: conversationId, title, messages: snapshot, createdAt: existing?.createdAt || now, updatedAt: now };
      return [next, ...current.filter((item) => item.id !== conversationId)];
    });
    setHistoryStatus("saving");
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      if (deletedConversationIds.current.has(conversationId)) { setHistoryStatus("idle"); return; }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (deletedConversationIds.current.has(conversationId)) { setHistoryStatus("idle"); return; }
          const response = await fetch("/api/assistant/history", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, messages: snapshot }) });
          if (!response.ok) throw new Error("history save failed");
          const saved = await response.json().catch(() => null) as AssistantHistoryState | null;
          lastSavedHistory.current.set(conversationId, serialized);
          if (saved?.conversations) setConversations(saved.conversations);
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
  }, [conversationId, messages, userId, historyRetry]);
  useEffect(() => { if (open && stickToBottom.current) endRef.current?.scrollIntoView({ behavior: loading ? "smooth" : "auto" }); }, [messages, loading, open]);
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "38px";
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
  }, [input]);
  useEffect(() => {
    if (!open || !window.matchMedia("(min-width: 640px)").matches) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { if (previewImage) setPreviewImage(null); else if (historyOpen) setHistoryOpen(false); else setOpen(false); } };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, historyOpen, previewImage]);

  async function send(value: string, retryIndex?: number) {
    const selectedImages = typeof retryIndex === "number" ? [] : pendingImages;
    const question = value.trim() || (selectedImages.length ? "请分析这些图片" : "");
    if (!question) return;
    if (loading) {
      requestGeneration.current += 1;
      requestController.current?.abort();
      requestController.current = null;
      setLoading(false);
    }
    const base = typeof retryIndex === "number" ? messages.slice(0, retryIndex) : messages;
    const alreadyHasQuestion = base.at(-1)?.role === "user" && base.at(-1)?.content === question;
    const next = (alreadyHasQuestion ? base : [...base, { role: "user" as const, content: question }]).slice(-MAX_SAVED_MESSAGES);
    if (!conversationId) setConversationId(newConversationId());
    const generation = requestGeneration.current;
    const controller = new AbortController();
    requestController.current = controller;
    setMessages(next);
    setInput("");
    setPendingImages([]);
    pendingImageBytesRef.current = 0;
    setAttachmentError("");
    stickToBottom.current = true;
    setLoading(true);
    try {
      const filter = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("filter") || "";
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, images: selectedImages.map(({ name, dataUrl }) => ({ name, dataUrl })), context: { page, label: copy.label, symbol, filter } }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null) as { answer?: string; error?: string; action?: AssistantAction } | null;
      if (!response.ok) throw new Error(data?.error || "暂时无法回答");
      if (requestGeneration.current === generation) {
        setMessages((current) => [...current, { role: "assistant" as const, content: data?.answer || "暂时没有结果", action: data?.action }].slice(-MAX_SAVED_MESSAGES));
      }
    } catch (error) {
      if (requestGeneration.current === generation && !(error instanceof DOMException && error.name === "AbortError")) {
        setMessages((current) => [...current, { role: "assistant" as const, content: error instanceof Error ? error.message : "连接失败，请稍后重试", responseError: true, retryQuestion: question }].slice(-MAX_SAVED_MESSAGES));
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (requestGeneration.current === generation) setLoading(false);
    }
  }

  async function addImages(files: File[]) {
    setAttachmentError("");
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length !== files.length) setAttachmentError("只能添加图片文件");
    let totalBytes = pendingImageBytesRef.current;
    const withinTotal = images.filter((file) => {
      if (totalBytes + file.size > MAX_IMAGE_TOTAL_BYTES) { setAttachmentError("单次提问的图片总大小不能超过 100MB"); return false; }
      totalBytes += file.size;
      return true;
    });
    const reservedBytes = withinTotal.reduce((sum, file) => sum + file.size, 0);
    pendingImageBytesRef.current += reservedBytes;
    const settled = await Promise.allSettled(withinTotal.map((file) => new Promise<PendingImage>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id: `assistant-image-${Date.now()}-${++pendingImageSequenceRef.current}`, name: file.name || "粘贴的图片", dataUrl: String(reader.result), size: file.size });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })));
    const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedBytes = reservedBytes - loaded.reduce((sum, image) => sum + image.size, 0);
    pendingImageBytesRef.current -= failedBytes;
    if (failedBytes) setAttachmentError("部分图片无法读取，请重新添加");
    setPendingImages((current) => [...current, ...loaded]);
  }

  function stopGenerating() {
    requestGeneration.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
  }

  function startNewChat() {
    if (actionOperationInFlight.current) return;
    requestGeneration.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
    setConversationId(newConversationId());
    setMessages([]);
    setInput("");
    setPendingImages([]);
    pendingImageBytesRef.current = 0;
    stickToBottom.current = true;
    setHistoryOpen(false);
  }

  function selectConversation(conversation: StoredAssistantConversation) {
    if (actionOperationInFlight.current) return;
    requestGeneration.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
    lastSavedHistory.current.delete(conversation.id);
    setConversationId(conversation.id);
    setMessages(conversation.messages as Message[]);
    setPendingImages([]);
    pendingImageBytesRef.current = 0;
    setAttachmentError("");
    stickToBottom.current = true;
    setHistoryOpen(false);
  }

  async function deleteConversation(id: string) {
    if (actionOperationInFlight.current) return;
    setHistoryError("");
    deletedConversationIds.current.add(id);
    try {
      await saveQueue.current.catch(() => undefined);
      const response = await fetch(`/api/assistant/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("删除失败");
      const next = await response.json() as AssistantHistoryState;
      lastSavedHistory.current.delete(id);
      setConversations(next.conversations);
      if (id === conversationId) {
        const active = next.conversations.find((item) => item.id === next.activeId) || next.conversations[0];
        setConversationId(active?.id || newConversationId());
        setMessages((active?.messages || []) as Message[]);
        stickToBottom.current = true;
      }
    } catch {
      setHistoryError("删除失败，请稍后重试");
    } finally {
      deletedConversationIds.current.delete(id);
    }
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

  function startFloatingDrag(target: FloatingTarget, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (target === "panel" && (event.target as HTMLElement).closest("button, input, textarea, a, [role='button']"))) return;
    const element = target === "launcher" ? launcherRef.current : panelRef.current;
    if (!element) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const origin = { x: rect.left, y: rect.top };
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const setter = target === "launcher" ? setLauncherPosition : setPanelPosition;
    document.body.style.userSelect = "none";
    element.dataset.dragging = "true";
    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - start.x;
      const deltaY = moveEvent.clientY - start.y;
      if (Math.hypot(deltaX, deltaY) > 4) moved = true;
      setter(clampFloatingPosition({ x: origin.x + deltaX, y: origin.y + deltaY }, rect.width, rect.height));
    };
    const finish = (endEvent?: PointerEvent) => {
      if (endEvent && Math.hypot(endEvent.clientX - start.x, endEvent.clientY - start.y) > 4) moved = true;
      const currentRect = element.getBoundingClientRect();
      const finalPosition = clampFloatingPosition({ x: currentRect.left, y: currentRect.top }, currentRect.width, currentRect.height);
      setter(finalPosition);
      writePersistentPreference(floatingPositionKey(userId, target), JSON.stringify(finalPosition));
      if (target === "launcher" && moved) suppressLauncherClick.current = true;
      delete element.dataset.dragging;
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  if (!mounted) return null;
  return createPortal(
    <>
      <button ref={launcherRef} type="button" aria-pressed={open} onPointerDown={(event) => startFloatingDrag("launcher", event)} onClick={() => { if (suppressLauncherClick.current) { suppressLauncherClick.current = false; return; } setOpen((value) => !value); }} style={launcherPosition ? { left: launcherPosition.x, top: launcherPosition.y, right: "auto", bottom: "auto" } : undefined} className="assistant-launcher fixed bottom-5 right-5 z-[110] flex h-12 w-12 touch-none cursor-grab items-center justify-center rounded-full border border-white/15 bg-[#15191d] text-white shadow-[0_12px_34px_rgba(0,0,0,.3)] transition-[background-color,box-shadow,transform] duration-200 hover:bg-[#20252a] hover:shadow-[0_14px_38px_rgba(0,0,0,.36)] active:scale-95 active:cursor-grabbing data-[dragging=true]:scale-100 sm:bottom-7 sm:right-7 sm:h-14 sm:w-14" aria-label={open ? "收起智能助手" : "打开智能助手"} title={open ? "拖动可移动，点击收起智能助手" : "拖动可移动，点击打开智能助手"}>
          <AssistantGlyph size={25} />
      </button>
      {open && (
        <div onMouseDown={(event) => { if (!pinned && event.target === event.currentTarget) setOpen(false); }} className="assistant-layer fixed inset-0 z-[100] flex items-end justify-end bg-black/20 sm:pointer-events-none sm:bg-transparent">
          <section ref={panelRef} role="dialog" aria-modal="true" aria-label="智能助手" style={panelPosition ? { position: "fixed", left: panelPosition.x, top: panelPosition.y, right: "auto", bottom: "auto" } : undefined} className="assistant-panel pointer-events-auto relative flex h-[72dvh] w-full flex-col overflow-hidden rounded-t-[22px] border border-[#e1e7e6] bg-white shadow-[0_24px_80px_rgba(15,23,42,.16)] dark:border-white/10 dark:bg-[#17191d] dark:shadow-[0_24px_80px_rgba(0,0,0,.45)] sm:mb-7 sm:mr-7 sm:h-[min(680px,calc(100dvh-112px))] sm:w-[420px] sm:rounded-[22px]">
            <header onPointerDown={(event) => startFloatingDrag("panel", event)} className="flex min-h-[68px] touch-none cursor-grab items-center gap-2 border-b border-edge px-4 active:cursor-grabbing sm:gap-2.5 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#15191d] text-white shadow-[0_5px_16px_rgba(0,0,0,.18)]"><AssistantGlyph size={20} /></span>
              <div className="min-w-0 flex-1 truncate text-sm font-semibold text-ink dark:text-white/90">智能助手</div>
              <button type="button" disabled={actionBusy} onPointerDown={(event) => event.stopPropagation()} onClick={() => setHistoryOpen((value) => !value)} className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-35" aria-label="对话归档" title="对话归档"><IconHistory size={18} /></button>
              <button type="button" disabled={actionBusy} onPointerDown={(event) => event.stopPropagation()} onClick={startNewChat} className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-35" aria-label="开始新对话" title={actionBusy ? "操作完成后可开始新对话" : "开始新对话"}><IconPlus size={18} /></button>
              <button type="button" aria-pressed={pinned} onPointerDown={(event) => event.stopPropagation()} onClick={() => setPinned((value) => { const next = !value; writePersistentPreference(`fire:assistant:pinned:${userId}`, next ? "1" : "0"); return next; })} className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-gray dark:text-white/60 dark:hover:bg-white/10 ${pinned ? "bg-bg-gray dark:bg-white/10" : ""}`} aria-label={pinned ? "取消置顶" : "置顶智能助手"} title={pinned ? "已置顶，点击取消" : "置顶面板"}>
                <svg viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                  <path d="M14 4v5l3 3v2H7v-2l3-3V4" />
                  <path d="M9 4h6" />
                  <path d="M12 14v6" />
                </svg>
              </button>
              <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen(false)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-bg-gray" aria-label="关闭"><IconX size={18} /></button>
            </header>
            {historyOpen && <div className="absolute inset-x-0 bottom-0 top-[68px] z-20 bg-white dark:bg-[#17191d]">
              <aside className="flex h-full w-full flex-col" aria-label="历史对话抽屉">
                <div className="border-b border-edge px-4 pb-3 pt-4 dark:border-white/10">
                  <div className="flex items-center justify-between">
                    <div><div className="text-base font-semibold tracking-tight text-ink dark:text-white/90">对话归档</div><div className="mt-0.5 text-[11px] text-faint dark:text-white/40">{conversations.length ? `共 ${conversations.length} 个对话` : "你的对话会保留在这里"}</div></div>
                    <button type="button" onClick={() => setHistoryOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-gray dark:text-white/55 dark:hover:bg-white/10" aria-label="关闭对话归档"><IconX size={17} /></button>
                  </div>
                  {conversations.length > 0 && <label className="mt-3 flex h-9 items-center gap-2 rounded-xl border border-edge bg-bg-gray/55 px-3 text-muted focus-within:border-edge-strong dark:border-white/10 dark:bg-white/[.045] dark:text-white/45 dark:focus-within:border-white/20"><IconSearch size={15} /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-faint dark:text-white/85 dark:placeholder:text-white/30" placeholder="搜索对话" /></label>}
                </div>
                <div className="flex-1 overflow-y-auto p-3">
                  {conversations.length === 0 ? <div className="flex h-full flex-col items-center justify-center px-8 pb-16 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-gray text-muted dark:bg-white/[.06] dark:text-white/45"><IconMessageCircle size={22} /></span><div className="mt-4 text-sm font-semibold text-ink dark:text-white/85">还没有归档对话</div><p className="mt-1.5 text-xs leading-5 text-faint dark:text-white/35">开始一次对话后，它会自动保存并出现在这里。</p></div> : conversations.filter((conversation) => !historyQuery.trim() || conversation.title.toLowerCase().includes(historyQuery.trim().toLowerCase()) || conversation.id.toLowerCase().includes(historyQuery.trim().toLowerCase())).map((conversation) => <div key={conversation.id} role="button" tabIndex={actionBusy ? -1 : 0} aria-disabled={actionBusy} onClick={() => { if (!actionBusy) selectConversation(conversation); }} onKeyDown={(event) => { if (!actionBusy && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectConversation(conversation); } }} className={`group/history mb-1 flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${actionBusy ? "cursor-not-allowed opacity-40" : ""} ${conversation.id === conversationId ? "bg-[#f0f2f4] dark:bg-white/[.085]" : "hover:bg-bg-gray/80 dark:hover:bg-white/[.055]"}`}>
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${conversation.id === conversationId ? "bg-white text-[#626b78] shadow-sm dark:bg-white/10 dark:text-white/65" : "bg-bg-gray text-muted dark:bg-white/[.05] dark:text-white/40"}`}><IconMessageCircle size={16} /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink dark:text-white/85">{conversation.title}</span><span className="mt-0.5 block text-[10px] text-faint dark:text-white/35">{conversationTime(conversation.updatedAt)}</span></span>
                    <button type="button" onClick={(event) => { event.stopPropagation(); void deleteConversation(conversation.id); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-faint opacity-0 transition hover:bg-white hover:text-[#d14343] group-hover/history:opacity-100 focus:opacity-100 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-[#ff8c8c]" aria-label={`删除对话：${conversation.title}`} title="删除对话"><IconTrash size={15} /></button>
                  </div>)}
                  {conversations.length > 0 && conversations.every((conversation) => historyQuery.trim() && !conversation.title.toLowerCase().includes(historyQuery.trim().toLowerCase()) && !conversation.id.toLowerCase().includes(historyQuery.trim().toLowerCase())) && <div className="py-16 text-center text-xs text-faint dark:text-white/35">没有找到相关对话</div>}
                </div>
                {historyError && <div className="border-t border-edge p-3 text-center text-[11px] text-[#9b5555]">{historyError}</div>}
              </aside>
            </div>}
            <>
              <div ref={messageListRef} onScroll={(event) => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; }} className="flex-1 overflow-y-auto px-5 py-5">
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
                    {messages.map((message, index) => <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "border border-[#e0e3e7] bg-[#f3f4f6] text-[#374151] shadow-[0_4px_14px_rgba(15,23,42,.035)] dark:border-white/10 dark:bg-white/[.085] dark:text-white/80" : message.responseError ? "border border-[#ecd9d9] bg-[#fff8f8] text-[#7d4545] dark:border-[#6b3e3e] dark:bg-[#301f21] dark:text-[#f0b6b6]" : "bg-bg-gray text-ink dark:bg-white/[0.06] dark:text-white/85"}`}>{displayText(message.content)}{message.responseError && message.retryQuestion && <button type="button" disabled={loading} onClick={() => void send(message.retryQuestion as string, index)} className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-[#e3caca] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#9b5555] transition-colors hover:bg-[#fff3f3] disabled:opacity-40 dark:border-[#6b3e3e] dark:bg-white/5 dark:text-[#f0b6b6] dark:hover:bg-white/10"><IconRefresh size={13} />重新回答</button>}{message.action && <div className="mt-3 rounded-xl border border-edge bg-white/80 p-3 dark:border-white/10 dark:bg-white/5"><div className="text-xs font-medium text-ink dark:text-white/85">{actionSummary(message.action)}</div><button type="button" disabled={actionBusy || message.actionStatus === "running" || message.actionStatus === "done" || actionExpired(message.action)} onClick={() => void executeAction(message.action as AssistantAction, index)} className="mt-3 w-full rounded-xl border border-edge-strong bg-white px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-brand-hover disabled:opacity-55 dark:border-white/15 dark:bg-white/5 dark:text-white/85 dark:hover:bg-white/10">{message.actionStatus === "running" ? "处理中…" : message.actionStatus === "done" ? "已完成" : message.actionStatus === "uncertain" ? "安全重试并核对" : actionExpired(message.action) ? "预览已过期，请重新输入" : message.actionStatus === "error" ? "重试" : message.action.label}</button>{message.actionStatus === "uncertain" && <p className="mt-2 text-[11px] leading-5 text-muted">页面曾在执行过程中中断。安全重试会复用原操作标识：已成功则只返回原结果，未成功才执行。</p>}{message.actionStatus === "done" && message.undo && <button type="button" disabled={actionBusy || message.undoStatus === "running" || isTimestampExpired(message.undo.createdAt)} onClick={() => void undoAction(message.undo as UndoAction, index)} className="mt-2 w-full text-center text-[11px] text-muted hover:text-ink disabled:opacity-35 dark:hover:text-white">{message.undoStatus === "running" ? "撤销中…" : isTimestampExpired(message.undo.createdAt) ? "撤销窗口已结束" : message.undoStatus === "uncertain" ? "安全重试撤销" : message.undoStatus === "error" ? "重试撤销" : "撤销操作"}</button>}{message.undoStatus === "uncertain" && !isTimestampExpired(message.undo?.createdAt || "") && <p className="mt-1 text-[11px] leading-5 text-muted">撤销响应曾中断，再次点击不会重复撤销。</p>}</div>}</div></div>)}
                    {loading && <div className="flex justify-start"><div className="flex items-center gap-1.5 rounded-2xl bg-[#f3f4f6] px-4 py-3 text-[#8a929e] dark:bg-white/[.06] dark:text-white/45" role="status" aria-label="智能助手正在回答"><i className="assistant-dot" /><i className="assistant-dot [animation-delay:220ms]" /><i className="assistant-dot [animation-delay:440ms]" /></div></div>}
                    <div ref={endRef} />
                  </div>
                )}
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void send(input); }} onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === "file" && item.type.startsWith("image/"))) event.preventDefault(); }} onDrop={(event) => { const files = [...event.dataTransfer.files]; if (!files.some((file) => file.type.startsWith("image/"))) return; event.preventDefault(); void addImages(files); }} className="border-t border-edge p-4 pb-[max(16px,env(safe-area-inset-bottom))] dark:border-white/10">
                <div className="rounded-[20px] border border-edge-strong bg-bg-gray p-2 dark:border-white/12 dark:bg-white/[.045]">
                  {pendingImages.length > 0 && <div className="flex gap-2 overflow-x-auto px-1 pb-2" aria-label="待发送图片">{pendingImages.map((image) => <div key={image.id} role="button" tabIndex={0} onClick={() => setPreviewImage(image)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewImage(image); } }} className="group/image relative h-14 w-14 shrink-0 cursor-zoom-in overflow-hidden rounded-xl border border-edge bg-white dark:border-white/10 dark:bg-white/5" aria-label={`查看图片：${image.name}`}><img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover transition-transform duration-200 group-hover/image:scale-105" /><button type="button" onClick={(event) => { event.stopPropagation(); pendingImageBytesRef.current = Math.max(0, pendingImageBytesRef.current - image.size); setPendingImages((current) => current.filter((item) => item.id !== image.id)); if (previewImage?.id === image.id) setPreviewImage(null); }} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white opacity-90 shadow-sm transition hover:bg-black" aria-label={`移除图片：${image.name}`}><IconX size={12} /></button></div>)}</div>}
                  <div className="flex items-end gap-1.5">
                    <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void addImages(files); } }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(input); } }} rows={1} maxLength={1200} placeholder={`问问${copy.label}…`} className="max-h-28 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-sm text-ink placeholder:text-faint dark:text-white/85 dark:placeholder:text-white/30" />
                    <button type={loading && !input.trim() && pendingImages.length === 0 ? "button" : "submit"} disabled={!input.trim() && pendingImages.length === 0 && !loading} onClick={loading && !input.trim() && pendingImages.length === 0 ? stopGenerating : undefined} className={`group flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-all active:scale-95 ${input.trim() || pendingImages.length || loading ? "border-[#4caf58] bg-[#4caf58] text-white shadow-[0_4px_14px_rgba(76,175,88,.2)] hover:border-[#45a550] hover:bg-[#45a550]" : "border-[#dfe2e6] bg-[#eef0f2] text-[#a7adb5] dark:border-white/10 dark:bg-white/[.07] dark:text-white/25"}`} aria-label={loading && !input.trim() && pendingImages.length === 0 ? "停止生成" : "发送"}>{loading && !input.trim() && pendingImages.length === 0 ? <span className="h-3.5 w-3.5 rounded-[2px] bg-white" /> : <IconArrowUp size={20} stroke={2.1} className="transition-transform duration-200 group-hover:-translate-y-0.5" />}</button>
                  </div>
                </div>
                {attachmentError && <p role="alert" className="mt-2 px-1 text-[10px] text-[#a45353] dark:text-[#ef9a9a]">{attachmentError}</p>}
                {historyStatus === "error" && <button type="button" onClick={() => setHistoryRetry((value) => value + 1)} className="mt-2 w-full text-center text-[10px] text-muted hover:text-ink">对话保存失败，点击重试</button>}
              </form>
            </>
          </section>
        </div>
      )}
      {previewImage && <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`图片预览：${previewImage.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}>
        <div className="relative flex max-h-full max-w-full items-center justify-center">
          <img src={previewImage.dataUrl} alt={previewImage.name} className="max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] rounded-xl object-contain shadow-2xl" />
          <button type="button" onClick={() => setPreviewImage(null)} className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80" aria-label="关闭图片预览"><IconX size={20} /></button>
        </div>
      </div>}
    </>, document.body
  );
}
