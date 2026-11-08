import { IconCircleCheck, IconAlertCircle, IconClock } from "@tabler/icons-react";

/** Persisted operation feedback, separate from the transient toast. */
export default function OperationStatus({ state, children }: {state: "success" | "error" | "pending"; children: React.ReactNode}) {
  const Icon = state === "success" ? IconCircleCheck : state === "error" ? IconAlertCircle : IconClock;
  return <div className="operation-status" data-state={state} role={state === "error" ? "alert" : "status"}><Icon size={20} stroke={1.8} aria-hidden="true"/><span>{children}</span></div>;
}
