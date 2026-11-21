"use client";

import { IconInfoCircle } from "@tabler/icons-react";
import { Capsule } from "@/components/Capsule";
import type { ReactNode } from "react";

export default function DataUnavailable({ title, detail, onRetry, action }: { title: string; detail?: string; onRetry?: () => void; action?: ReactNode }) {
  return <div className="data-unavailable" role="status">
    <IconInfoCircle size={25} aria-hidden="true" />
    <strong>{title}</strong>{detail && <p>{detail}</p>}
    {(onRetry || action) && <div className="mt-1 flex flex-wrap justify-center gap-2">
      {onRetry && <Capsule variant="secondary" size="sm" onClick={onRetry}>重新读取</Capsule>}
      {action}
    </div>}
  </div>;
}
