"use client";

import { IconArrowsExchange, IconChartHistogram, IconCalendarPause, IconHierarchy2 } from "@tabler/icons-react";
import { NAV_ICONS } from "@/lib/navIcons";
import { useLayoutEffect, useRef } from "react";

export type GlobalSection = "allocation" | "assets" | "convert" | "calendar" | "quote-pool";

const GLOBAL_SECTIONS: [GlobalSection, string, string][] = [
  ["allocation", "资产配置", "账户关联与资产分布"],
  ["assets", "市值排行", "全球主要资产的市值、价格与走势"],
  ["convert", "汇率换算", "输入金额，按当前汇率换算其他货币"],
  ["calendar", "休市日历", "A 股、港股及美股全年交易与休市安排"],
  ["quote-pool", "股票池", "查看行情订阅与池内清单"]
];

const SECTION_ICONS = { allocation: IconHierarchy2, assets: IconChartHistogram, convert: IconArrowsExchange, calendar: IconCalendarPause };

export default function GlobalSectionNav({ section, onSelect }: { section: GlobalSection; onSelect: (section: GlobalSection) => void }) {
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const revealSelection = () => {
      const selected = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!selected) return;
      const bounds = nav.getBoundingClientRect(), item = selected.getBoundingClientRect();
      // Scroll this horizontal rail only; never move the page to reveal a tab.
      if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    };
    revealSelection();
    const observer = new ResizeObserver(revealSelection);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [section]);
  return <nav ref={navRef} className="global-section-nav" aria-label="全球经济功能">
    {GLOBAL_SECTIONS.map(([key, label, description]) => {
      const Icon = key === "quote-pool" ? null : SECTION_ICONS[key];
      return <button key={key} type="button" onClick={() => onSelect(key)} title={label} aria-label={label}
        aria-current={section === key ? "page" : undefined} className={`global-section-button ${section === key ? "is-active" : ""}`}>
        {Icon ? <Icon className="global-section-icon" size={18} stroke={1.65} aria-hidden="true" /> : <span className="global-section-icon" aria-hidden="true">{NAV_ICONS["quote-pool"]}</span>}
        <span>{label}</span><span className="sr-only">：{description}</span>
      </button>;
    })}
  </nav>;
}
