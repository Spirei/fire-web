"use client";
import { useEffect, useRef, useState } from "react";

type Result = { endpoint: string; busy: boolean; ok?: boolean; msg?: string; failed?: boolean; retained?: boolean; observedAt?: string };
type Health = { endpoint: string; available: boolean; skipped: boolean };
const endpointKey = (host: string, port: string | number) => JSON.stringify([host.trim().toLowerCase() || "127.0.0.1", Number(port) || 11111]);

/** The latest explicit test belongs to its endpoint and takes precedence over the initial health read. */
export function useFutuConnectionStatus(host: string, port: string, enabled = true) {
  const endpoint = endpointKey(host, port);
  const [health, setHealth] = useState<Health | null>(null), [healthFailed, setHealthFailed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const alive = useRef(false), sequence = useRef(0), pending = useRef<AbortController | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentEndpoint = useRef(endpoint); currentEndpoint.current = endpoint;
  useEffect(() => {
    alive.current = enabled;
    if (!enabled) return;
    let disposed = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    void (async () => {
      try {
        const response = await fetch("/api/futu/test", { cache: "no-store", signal: controller.signal });
        const status = await response.json();
        if (!response.ok || !status || typeof status.host !== "string" || typeof status.port !== "number") throw Error("Invalid OpenD status");
        if (!disposed && alive.current && !controller.signal.aborted) {
          const checkedEndpoint = endpointKey(status.host, status.port);
          setHealth({ endpoint: checkedEndpoint, available: false, skipped: false });
          const last = status.lastTest;
          // The latest explicit test wins if this slower retained read arrives afterwards.
          if (last && typeof last.ok === "boolean") setResult(current => current?.endpoint === checkedEndpoint ? current : ({endpoint: checkedEndpoint, busy: false, ok: last.ok, msg: last.message, retained: true, observedAt: last.observedAt}));
        }
      } catch {
        if (!disposed && alive.current) setHealthFailed(true);
      } finally { clearTimeout(timer); }
    })();
    return () => { disposed = true; alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [endpoint, enabled]);
  useEffect(() => {
    ++sequence.current; clearTimeout(pendingTimer.current); pending.current?.abort(); pending.current = null; setResult(null);
    return () => { ++sequence.current; clearTimeout(pendingTimer.current); pending.current?.abort(); pending.current = null; };
  }, [endpoint, enabled]);

  async function test() {
    if (pending.current || !alive.current) return;
    const id = ++sequence.current, controller = new AbortController(); pending.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 40_000);
    pendingTimer.current = timer;
    const active = () => alive.current && sequence.current === id && currentEndpoint.current === endpoint;
    setResult({ endpoint, busy: true });
    try {
      const response = await fetch("/api/futu/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host, port }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || typeof data?.ok !== "boolean") throw Error(data?.error || data?.message || "连接测试响应无效");
      if (active()) setResult({ endpoint, busy: false, ok: data.ok, msg: data.message || (data.ok ? "连接成功" : "连接失败") });
    } catch (error) {
      if (active()) setResult({ endpoint, busy: false, ok: false, failed: true, msg: timedOut ? "连接测试超时，请重试" : error instanceof Error ? error.message : "连接失败" });
    } finally {
      clearTimeout(timer); if (pending.current === controller) { pending.current = null; pendingTimer.current = undefined; }
    }
  }
  const testResult = result?.endpoint === endpoint ? result : null;
  const status = testResult ? testResult.busy ? "testing" : testResult.failed ? "failed" : testResult.ok ? "connected" : "disconnected"
    : health?.endpoint === endpoint ? "untested"
    : health ? "untested" : healthFailed ? "untested" : "checking";
  const label = testResult?.retained ? testResult.ok ? "上次已连接" : "上次未连接" : { testing: "测试中…", failed: "检测失败", connected: "已连接", disconnected: "未连接", untested: "未测试", checking: "读取中…" }[status];
  return { label, online: status === "connected", checking: status === "checking" || status === "testing", skipped: health?.skipped ?? false, result: testResult, test };
}
