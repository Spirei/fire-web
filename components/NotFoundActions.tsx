"use client";

import Link from "next/link";

export default function NotFoundActions() {
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row">
      <Link
        href="/"
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#11151f] px-5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(10,14,25,.16)] transition hover:-translate-y-0.5 hover:bg-[#242a35] dark:bg-white dark:text-[#11151f] dark:hover:bg-[#eef0f3]"
      >
        返回首页
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </Link>
      <button
        type="button"
        onClick={() => window.history.back()}
        className="inline-flex h-11 items-center justify-center rounded-full border border-edge-strong bg-white/75 px-5 text-sm font-semibold text-ink-2 backdrop-blur-sm transition hover:-translate-y-0.5 hover:bg-white dark:border-white/15 dark:bg-white/[.06] dark:text-[#d8dde6] dark:hover:bg-white/10"
      >
        返回上一页
      </button>
    </div>
  );
}
