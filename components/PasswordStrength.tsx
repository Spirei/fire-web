"use client";

import { useEffect, useRef, useState } from "react";
import { estimatePasswordStrength, PASSWORD_STRENGTH_LABELS } from "@/lib/passwordStrength";

export default function PasswordStrength({ password, userInputs = [] }: { password: string; userInputs?: string[] }) {
  const [score, setScore] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);
  const context = JSON.stringify(userInputs);
  useEffect(() => {
    let active = true;
    if (!password) { setScore(null); setFailed(false); return; }
    const controller = new AbortController();
    const id = ++requestId.current;
    let worker: Worker | null = null;
    const receive = (event: MessageEvent<{ id: number; score?: number; failed?: boolean }>) => {
      if (!active || event.data.id !== id) return;
      setScore(typeof event.data.score === "number" ? event.data.score : null);
      setFailed(Boolean(event.data.failed));
    };
    const fail = () => {
      if (active) { setScore(null); setFailed(true); }
      worker?.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    const timer = setTimeout(() => {
      if (typeof Worker !== "undefined") {
        try {
          workerRef.current ??= new Worker(new URL("../lib/passwordStrength.worker.ts", import.meta.url), { type: "module" });
          worker = workerRef.current;
          worker.addEventListener("message", receive);
          worker.addEventListener("error", fail);
          worker.postMessage({ id, password, userInputs: JSON.parse(context) });
        } catch { fail(); }
        return;
      }
      void estimatePasswordStrength(password, JSON.parse(context), controller.signal).then(value => {
        if (active) { setScore(value); setFailed(false); }
      }).catch(() => { if (active) { setScore(null); setFailed(true); } });
    }, 120);
    return () => {
      active = false; controller.abort(); clearTimeout(timer);
      worker?.removeEventListener("message", receive);
      worker?.removeEventListener("error", fail);
      if (worker && workerRef.current === worker) worker.postMessage({ id, cancel: true });
    };
  }, [password, context]);
  if (!password) return null;
  const label = score === null ? failed ? "暂无法检测" : "检测中…" : PASSWORD_STRENGTH_LABELS[score];
  return <div className="password-strength" data-score={score ?? "pending"}>
    <div className="password-strength-track" role={score === null ? undefined : "meter"} aria-label="密码强度" aria-valuemin={0} aria-valuemax={4} aria-valuenow={score ?? undefined} aria-valuetext={label}>
      {[0, 1, 2, 3, 4].map(index => <i key={index} data-filled={score !== null && index <= score} />)}
    </div>
    <div className="password-strength-caption" aria-live="polite"><span>密码强度</span><b>{label}</b></div>
  </div>;
}
