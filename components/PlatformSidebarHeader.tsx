"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NAV_ICONS } from "@/lib/navIcons";
import { IconBackspace, IconClock, IconLayoutSidebar, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import { Capsule, IconButton } from "./Capsule";
import { SubNavIcon } from "./SettingsHeader";
import { ADMIN_SUB_KEYS, SETTINGS_SEARCH_INDEX, SETTINGS_ANCHOR_ICONS } from "@/lib/settingsCatalog";
import { useSearchHistory } from "@/lib/useSearchHistory";
import { lockScroll, trapModalTab } from "@/lib/overlayLifecycle";
import { matchPlatformDestinations } from "@/lib/platformSearch";

export default function PlatformSidebarHeader({ collapsed, onToggle, items, onSelect, onSettings, admin = false, ownerId, title = "Alcor" }: {
  collapsed: boolean; onToggle: () => void; title?: string; admin?: boolean; ownerId: string;
  items: { key: string; label: string; icon: ReactNode }[];
  onSelect: (key: string) => void; onSettings: (sub: string, anchor?: string) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId(), history = useSearchHistory(ownerId, open);
  const destinations = [
    ...items.map(item => ({ ...item, keywords: item.key, group: "", run: () => onSelect(item.key) })),
    { key: "profile-home", label: "个人主页", icon: NAV_ICONS["profile-home"], keywords: "头像 昵称 简介 请求统计 profile", group: "", run: () => onSettings("profile-home") },
    { key: "palette", label: "外观", icon: NAV_ICONS.palette, keywords: SETTINGS_SEARCH_INDEX.find(item => item.sub === "palette")!.keywords, group: "", run: () => onSettings("palette") },
    ...SETTINGS_SEARCH_INDEX.filter(item => item.sub !== "palette" && (admin || (!ADMIN_SUB_KEYS.has(item.sub) && !item.adminOnly))).map(item => ({
      key: `settings:${item.sub}:${item.anchor}`, label: item.label,
      icon: <SubNavIcon name={SETTINGS_ANCHOR_ICONS[item.anchor] || item.sub}/>, keywords: item.keywords, group: item.groupLabel,
      run: () => onSettings(item.sub, item.anchor),
    })),
  ];
  const search = query.trim().length > 0;
  const matches = matchPlatformDestinations(destinations, query);
  const activeIndex = matches.findIndex(item => item.key === activeKey);
  const resultsId = `${titleId}-results`;
  const optionId = (index: number) => `${resultsId}-${index}`;
  const changeQuery = (value: string) => { setQuery(value); setActiveKey(null); };
  const openSearch = () => {
    if (open) {
      input.current?.focus();
      return;
    }
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    changeQuery("");
    setOpen(true);
  };
  const close = () => { setOpen(false); previousFocus.current?.focus(); };
  const select = (run?: () => void) => { history.record(query); if (run) { close(); run(); } };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.repeat && !event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (open) close(); else openSearch();
      }
    };
    window.addEventListener("keydown", shortcut, true);
    window.addEventListener("fire:global-search-open", openSearch);
    return () => { window.removeEventListener("keydown", shortcut, true); window.removeEventListener("fire:global-search-open", openSearch); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const unlock = lockScroll();
    const onNavigate = () => setOpen(false);
    window.addEventListener("fire:navigate", onNavigate);
    return () => { unlock(); window.removeEventListener("fire:navigate", onNavigate); };
  }, [open]);
  return <>
    <div className="platform-sidebar-top"><span className="platform-sidebar-brand">{title}</span><button type="button" data-capsule="off" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed} aria-controls="fire-desktop-nav" title={collapsed ? "展开侧栏" : "收起侧栏"}><IconLayoutSidebar size={20} stroke={1.6}/></button></div>
    <button type="button" className="platform-sidebar-search" data-capsule="off" aria-label="搜索功能" onClick={openSearch} title="搜索功能（⌘ K / Ctrl K）"><IconSearch size={20} stroke={1.6}/><span>搜索功能</span><kbd>⌘ K</kbd></button>
    {open && createPortal(<div className="platform-search-overlay" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} className="platform-search-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (dialog.current) trapModalTab(event.nativeEvent, dialog.current);
      }}>
        <div className="platform-search-input">
          <IconSearch size={20} aria-hidden="true"/>
          <label id={titleId} className="sr-only" htmlFor={`${titleId}-input`}>搜索功能</label>
          <input ref={input} id={`${titleId}-input`} role="combobox" aria-autocomplete="list"
            aria-expanded={matches.length > 0} aria-controls={matches.length > 0 ? resultsId : undefined}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            value={query} maxLength={160} onChange={event => changeQuery(event.target.value)}
            placeholder="搜索功能或设置" autoComplete="off" onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter" && search) {
                event.preventDefault();
                select(matches[activeIndex >= 0 ? activeIndex : 0]?.run);
              }
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length > 0) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                const next = activeIndex < 0 && step < 0
                  ? matches.length - 1 : (activeIndex + step + matches.length) % matches.length;
                setActiveKey(matches[next].key);
                document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
              }
            }}/>
          {!!query && <IconButton label="清空关键词" onClick={() => { changeQuery(""); input.current?.focus(); }}><IconBackspace size={18}/></IconButton>}
          <IconButton label="关闭搜索" onClick={close}><IconX size={18}/></IconButton>
        </div>
        {search && matches.length > 0 && <div className="platform-search-results" id={resultsId} role="listbox" aria-label="匹配功能">
          {matches.map((item, index) => <button type="button" role="option" tabIndex={-1} id={optionId(index)}
            aria-selected={activeIndex === index} data-capsule="off" key={item.key} onClick={() => select(item.run)}>
            {item.icon}<span>{item.label}</span>{item.group && <small>{item.group}</small>}
          </button>)}
        </div>}
        {search && matches.length === 0 && <p className="platform-search-empty" role="status">没有匹配的功能</p>}
        {!search && history.items.length > 0 && <section className="platform-search-history" aria-label="搜索历史">
          <div className="platform-search-history-head"><span>最近搜索</span><Capsule variant="secondary" disabled={history.busy} onClick={history.clear}>清空历史</Capsule></div>
          <div className="platform-search-history-list">{history.items.map(item => <div className="platform-search-history-row" key={item.id}>
            <button type="button" data-capsule="off" onClick={() => { changeQuery(item.query); input.current?.focus(); }}><IconClock size={18}/><span>{item.query}</span></button>
            <IconButton label={`删除搜索：${item.query}`} disabled={history.busy} onClick={() => history.remove(item.id)}><IconTrash size={17}/></IconButton>
          </div>)}</div>
        </section>}
        {!search && history.error && <div className="platform-search-history-error" role="status"><span>{history.error}</span><Capsule variant="secondary" disabled={history.loading} onClick={() => void history.refresh()}>重试</Capsule></div>}
      </div>
    </div>, document.body)}
  </>;
}
