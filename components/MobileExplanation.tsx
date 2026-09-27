import type { ReactNode } from "react";

/** Layout-only disclosure: identical SSR/first client frame, no viewport JS or persistent state. */
export default function MobileExplanation({ summary, children, mobileContent = children, className = "" }: { summary: ReactNode; children: ReactNode; mobileContent?: ReactNode; className?: string }) {
  return <div className={className}>
    <div className="hidden md:block">{children}</div>
    <details className="mobile-explanation md:hidden"><summary><span>{summary}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary><div className="mobile-explanation-body">{mobileContent}</div></details>
  </div>;
}
