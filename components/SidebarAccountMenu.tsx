"use client";
import { useEffect, useId, useRef, useState } from "react";
import { IconAdjustmentsHorizontal, IconBellOff, IconLogout, IconMessageCircleFilled, IconSun, IconTarget, IconUser } from "@tabler/icons-react";
import type { User } from "@/lib/types";
import { usePersistedState } from "@/lib/usePersistedState";
const statuses = [
    { value: "online", label: "在线", Icon: IconMessageCircleFilled },
    { value: "focus", label: "专注", Icon: IconTarget },
    { value: "doNotDisturb", label: "勿扰", Icon: IconBellOff },
] as const;
type Status = typeof statuses[number]["value"];
export default function SidebarAccountMenu({ user, avatar, dark, onProfile, onHome, onSettings, onTheme, onLogout }: {
    user: User;
    avatar?: string;
    dark: boolean;
    onHome: () => void;
    onProfile: () => void;
    onSettings: () => void;
    onTheme: () => void;
    onLogout: () => void;
}) {
    const [open, setOpen] = useState<"account" | "status" | null>(null);
    const [savedStatus, setStatus] = usePersistedState<Status>(`fire:account-status:${user.id}`, "online");
    const status = statuses.find(item => item.value === savedStatus) || statuses[0];
    const root = useRef<HTMLDivElement>(null);
    const accountTrigger = useRef<HTMLButtonElement>(null);
    const statusTrigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const menuId = useId(), statusId = useId();
    const name = user.nickname || user.username;
    const role = user.role === "admin" ? "管理员" : "用户";
    useEffect(() => {
        if (!open)
            return;
        panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
        const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node))
            setOpen(null); };
        const closeEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(null);
                (open === "account" ? accountTrigger : statusTrigger).current?.focus();
            }
        };
        const closeNavigation = () => setOpen(null);
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeEscape);
        window.addEventListener("fire:navigate", closeNavigation);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            document.removeEventListener("keydown", closeEscape);
            window.removeEventListener("fire:navigate", closeNavigation);
        };
    }, [open]);
    const act = (action: () => void) => { setOpen(null); action(); };
    const avatarNode = avatar ? <img src={avatar} alt=""/> : <span>{name.slice(0, 1).toUpperCase()}</span>;
    return <div ref={root} className="platform-account" onBlur={event => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
                setOpen(null);
        }}>
    <button ref={accountTrigger} type="button" className="platform-account-trigger" data-capsule="off" aria-label="账号菜单" aria-expanded={open === "account"} aria-controls={menuId} onClick={() => setOpen(value => value === "account" ? null : "account")}>
      <span className="platform-account-avatar">{avatarNode}</span>
      <span className="platform-account-copy"><strong>{name}</strong><small>{role}</small></span>
    </button>
    <button ref={statusTrigger} type="button" className="platform-status-trigger" data-capsule="off" aria-label="更改状态" title={`状态：${status.label}`} aria-expanded={open === "status"} aria-controls={statusId} onClick={() => setOpen(value => value === "status" ? null : "status")}>
      <span className={`platform-status-dot ${status.value}`} role="img" aria-label={`状态：${status.label}`}/>
    </button>
    {open === "account" && <div ref={panel} id={menuId} className="platform-account-popover" role="dialog" aria-label="账户">
      <button type="button" className="platform-account-profile" data-capsule="off" onClick={() => act(onHome)}>
        <span className="platform-account-avatar">{avatarNode}</span>
        <span className="platform-account-copy"><strong>{name}</strong><small>{role}</small></span>
      </button>
      <div className="platform-account-separator"/>
      <button type="button" data-capsule="off" onClick={() => act(onProfile)}><IconUser size={19} stroke={1.6}/>个人信息</button>
      <button type="button" data-capsule="off" onClick={() => act(onSettings)}><IconAdjustmentsHorizontal size={19} stroke={1.6}/>设置</button>
      <button type="button" data-capsule="off" onClick={onTheme}><IconSun size={19} stroke={1.6}/>主题：{dark ? "深色" : "浅色"}</button>
      <div className="platform-account-separator"/>
      <button type="button" data-capsule="off" onClick={() => act(onLogout)}><IconLogout size={19} stroke={1.6}/>退出登录</button>
    </div>}
    {open === "status" && <div ref={panel} id={statusId} className="platform-status-popover" role="group" aria-label="状态">
      {statuses.map(({ value, label, Icon }) => <button key={value} type="button" data-capsule="off" className={`platform-status-choice ${value}`} aria-label={label} title={label} aria-pressed={status.value === value} onClick={() => { setStatus(value); setOpen(null); statusTrigger.current?.focus(); }}><Icon size={19} stroke={1.8}/></button>)}
    </div>}
  </div>;
}
