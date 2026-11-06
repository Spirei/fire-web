"use client";

import { Capsule } from "@/components/Capsule";
import { useState } from "react";

const btnCls = "pagination-control";

export default function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  const [jump, setJump] = useState("");
  if (total <= 1) return null;
  const safe = Math.max(1, Math.min(total, page));

  // 智能页码：首尾 + 当前页附近，中间用省略号
  const items: (number | "…")[] = [];
  const add = (n: number) => {
    if (items[items.length - 1] !== n) items.push(n);
  };
  const dots = () => {
    if (items[items.length - 1] !== "…") items.push("…");
  };
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || Math.abs(i - safe) <= 1) add(i);
    else dots();
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
      <Capsule type="button" disabled={safe <= 1} onClick={() => onChange(safe - 1)} className={btnCls}>
        上一页
      </Capsule>
      {items.map((it, i) =>
        it === "…" ? (
          <span key={`d${i}`} className="px-1 text-xs text-faint">
            …
          </span>
        ) : (
          <Capsule
            key={it}
            type="button"
            onClick={() => onChange(it)}
            className={btnCls}
            selected={it === safe}
            aria-current={it === safe ? "page" : undefined}
            aria-label={`第 ${it} 页`}
          >
            {it}
          </Capsule>
        )
      )}
      <Capsule type="button" disabled={safe >= total} onClick={() => onChange(safe + 1)} className={btnCls}>
        下一页
      </Capsule>
      <span className="ml-1 flex items-center gap-1 text-xs text-muted">
        共 {total} 页 · 跳至
        <input
          aria-label="跳转页码"
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = Number(jump);
              if (n >= 1 && n <= total) onChange(n);
              setJump("");
            }
          }}
          className="h-[30px] w-12 rounded-md border border-edge-strong bg-white px-1 text-center text-xs outline-none dark:bg-[#151a26] dark:text-[#e5e7eb]"
        />
        页
      </span>
    </div>
  );
}
