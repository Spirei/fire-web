import type { SVGProps } from "react";

/** Closed, padded outline shared by every visibility control. */
export default function VisibilityIcon({ hidden = false, ...props }: SVGProps<SVGSVGElement> & { hidden?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M2 12C4.5 7.3 7.8 5 12 5s7.5 2.3 10 7c-2.5 4.7-5.8 7-10 7S4.5 16.7 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    {hidden && <path d="M3 3l18 18" />}
  </svg>;
}
