"use client";

import { IconInfoCircle } from "@tabler/icons-react";
import { Capsule } from "@/components/Capsule";

export default function DataUnavailable({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return <div className="data-unavailable" role="status">
    <IconInfoCircle size={25} aria-hidden="true" />
    <strong>{title}</strong>{detail && <p>{detail}</p>}
    {onRetry && <Capsule variant="secondary" size="sm" onClick={onRetry}>重新读取</Capsule>}
  </div>;
}
