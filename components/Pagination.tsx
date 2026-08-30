"use client";

import { useState } from "react";

const btnCls =
  "inline-flex h-[34px] min-w-[34px] items-center justify-center rounded-full border border-edge-strong bg-white px-2.5 text-xs font-semibold text-brand-deep transition-all duration-200 hover:bg-brand-hover hover:text-ink active:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#16181d] dark:hover:bg-white/10";

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
    <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
      <button type="button" disabled={safe <= 1} onClick={() => onChange(safe - 1)} className={btnCls}>
        上一页
      </button>
      {items.map((it, i) =>
        it === "…" ? (
          <span key={`d${i}`} className="px-1 text-xs text-faint">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onChange(it)}
            className={`${btnCls} ${it === safe ? "bg-white text-ink-2 border border-edge-strong shadow-sm hover:bg-brand-hover hover:text-ink" : ""}`}
          >
            {it}
          </button>
        )
      )}
      <button type="button" disabled={safe >= total} onClick={() => onChange(safe + 1)} className={btnCls}>
        下一页
      </button>
      <span className="ml-1 flex items-center gap-1 text-xs text-muted">
        共 {total} 页 · 跳至
        <input
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
