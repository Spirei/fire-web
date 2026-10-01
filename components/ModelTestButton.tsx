"use client";

import MusicIcon from "./showcase/MusicIcon";

export type ModelTestState = { state: "loading" | "ok" | "error"; text: string };

export default function ModelTestButton({ result, model, compact = false, onTest }: {
  result?: ModelTestState;
  model: string;
  compact?: boolean;
  onTest: () => void;
}) {
  const state = result?.state || "idle";
  const label = state === "loading" ? "测试中" : state === "ok" ? `连接成功，耗时 ${result?.text}，点击重新测试` : state === "error" ? "重新测试" : "测试连接";
  return <button type="button" className={`model-connection-test${compact ? " is-compact" : ""}`} data-state={state}
    onClick={onTest} disabled={!model || state === "loading"} aria-busy={state === "loading"} aria-label={`${label} ${model}`}
    title={state === "error" ? `${result?.text}；点击重新测试` : label}>
    <span key={state} className="model-test-content" aria-live="polite">
      {state === "loading" ? <><MusicIcon playing className="model-test-wave" /><span className="sr-only">测试中</span></>
        : state === "ok" ? <><span className="model-test-dot is-ok" aria-hidden="true" /><span>成功</span></>
        : state === "error" ? <><span className="model-test-dot is-error" aria-hidden="true" /><span>失败</span><svg className="model-test-retry" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5" /><path d="M19.3 12a7.5 7.5 0 1 0-1.6 5.3M20 12l-2.3-5.3" /></svg></>
        : <span>{compact ? "测试" : "测试连接"}</span>}
    </span>
  </button>;
}
