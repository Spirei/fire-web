/** 苹果风格金钱图标（SF Symbols dollarsign.circle.fill 风）：实心圆 + 挖空的居中 $ */
export default function MoneyIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" />
      <g stroke="var(--money-cut, transparent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 6.2v11.6" />
        <path d="M15.25 8.8c-.52-.52-1.35-.87-2.42-.87-1.72 0-3.1.87-3.1 2.16 0 3.12 5.95 1.16 5.95 4.22 0 1.34-1.3 2.44-3.3 2.44-1.22 0-2.34-.4-3.13-1.07" />
      </g>
    </svg>
  );
}
