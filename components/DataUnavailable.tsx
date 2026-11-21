"use client";

import { IconInfoCircle } from "@tabler/icons-react";
import { Capsule } from "@/components/Capsule";
import type { ReactNode } from "react";

export default function DataUnavailable({ title, detail, onRetry, retrying, action }: { title: string; detail?: string; onRetry?: () => void; retrying?: boolean; action?: ReactNode }) {
  return <div className="data-unavailable" role="status">
    <IconInfoCircle size={25} aria-hidden="true" />
    <strong>{title}</strong>{detail && <p>{detail}</p>}
    {(onRetry || action) && <div className="mt-1 flex flex-wrap justify-center gap-2">
      {onRetry && <Capsule variant="secondary" size="sm" busy={retrying} onClick={onRetry}>{retrying ? "读取中…" : "重新读取"}</Capsule>}
      {action}
    </div>}
  </div>;
}
