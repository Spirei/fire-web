"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconLayoutSidebar, IconSearch, IconX } from "@tabler/icons-react";
export default function PlatformSidebarHeader({ collapsed, onToggle, items, onSelect, onSettings, title = "Alcor" }: {
    collapsed: boolean;
    onToggle: () => void;
    title?: string;
    items: {
        key: string;
        label: string;
        icon: ReactNode;
    }[];
    onSelect: (key: string) => void;
    onSettings: (sub: string) => void;
}) {
    const [open, setOpen] = useState(false), [query, setQuery] = useState("");
    const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const destinations = [
        ...items.map(item => ({ ...item, run: () => onSelect(item.key) })),
        { key: "profile-home", label: "个人主页", icon: null, run: () => onSettings("profile-home") },
        { key: "palette", label: "外观", icon: null, run: () => onSettings("palette") },
    ];
    const matches = destinations.filter(item => `${item.label} ${item.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const select = (run: () => void) => { setOpen(false); run(); };
    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                event.stopImmediatePropagation();
                setQuery("");
                setOpen(value => !value);
            }
        };
        window.addEventListener("keydown", shortcut, true);
        return () => window.removeEventListener("keydown", shortcut, true);
    }, []);
    useEffect(() => {
        if (!open)
            return;
        input.current?.focus();
        const onNavigate = () => setOpen(false);
        window.addEventListener("fire:navigate", onNavigate);
        return () => window.removeEventListener("fire:navigate", onNavigate);
    }, [open]);
    return <>
    <div className="platform-sidebar-top"><span className="platform-sidebar-brand">{title}</span><button type="button" data-capsule="off" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed} aria-controls="fire-desktop-nav" title={collapsed ? "展开侧栏" : "收起侧栏"}><IconLayoutSidebar size={20} stroke={1.6}/></button></div>
    <button ref={trigger} type="button" className="platform-sidebar-search" data-capsule="off" aria-label="搜索功能" onClick={() => { setQuery(""); setOpen(true); }} title="搜索功能（⌘ K / Ctrl K）"><IconSearch size={20} stroke={1.6}/><span>搜索功能</span><kbd>⌘ K</kbd></button>
    {open && createPortal(<div className="platform-search-overlay" onPointerDown={event => { if (event.target === event.currentTarget)
            close(); }}>
      <div ref={dialog} className="platform-search-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                }
                if (event.key === "Tab") {
                    const controls = dialog.current?.querySelectorAll<HTMLElement>('input,button');
                    if (!controls?.length)
                        return;
                    const first = controls[0], last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    }
                    else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            }}>
        <div className="platform-search-input"><IconSearch size={20}/><label id={titleId} className="sr-only" htmlFor={`${titleId}-input`}>搜索功能</label><input ref={input} id={`${titleId}-input`} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索功能" onKeyDown={event => { if (event.key === "Enter" && matches[0]) {
            event.preventDefault();
            select(matches[0].run);
        } }}/><button type="button" data-capsule="off" aria-label="关闭搜索" onClick={close}><IconX size={18}/></button></div>
        <div className="platform-search-results">{matches.map(item => <button type="button" data-capsule="off" key={item.key} onClick={() => select(item.run)}>{item.icon}<span>{item.label}</span></button>)}{!matches.length && <p role="status">没有匹配的功能</p>}</div>
      </div>
    </div>, document.body)}
  </>;
}
