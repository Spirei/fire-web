"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TimeMachineLink } from "@/components/TimeMachine";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/types";
import { THEME_KEY } from "@/components/ThemeToggle";
import { setThemeCookie } from "@/lib/theme";

interface StockStats {
  holdings: number;
  watchlist: number;
}

export default function UserMenu({ goTo, initialUser = null }: { goTo?: string; initialUser?: User | null }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(initialUser);
  const [ready, setReady] = useState(Boolean(initialUser));
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [stats, setStats] = useState<StockStats>({ holdings: 0, watchlist: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  function clearTimers() {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function openSoon() {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), 90);
  }

  function closeSoon() {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  }

  useEffect(() => {
    function loadUser() {
      fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json().catch(() => null);
            setUser(data?.user ?? null);
            setReady(true);
            return;
          }
          setReady(true);
          if (res.status !== 401) return;
          // 后台壳已有服务端用户：去登录页，不要在头像位置闪「登录」按钮。
          // 首页由 HomeContent 统一切换访客顶栏。
          if (initialUser && !goTo) {
            router.replace("/login");
            return;
          }
          if (!initialUser) setUser(null);
        })
        .catch(() => setReady(true));
    }
    loadUser();
    window.addEventListener("fire:user-updated", loadUser);
    return () => window.removeEventListener("fire:user-updated", loadUser);
  }, []);

  // 统计持股 / 自选股数量（有成本价与数量视为持仓，其余为自选）
  useEffect(() => {
    function loadStats() {
      fetch("/api/records")
        .then((res) => (res.ok ? res.json() : []))
        .then((list) => {
          const rows = Array.isArray(list) ? list : [];
          const holdings = rows.filter((r) => Number(r.qty) > 0).length;
          // 自选股 = 自选股页面显示的全部记录数（与持仓页面口径一致：持仓页显示有数量、自选页显示全部）
          setStats({ holdings, watchlist: rows.length });
        })
        .catch(() => {});
    }
    loadStats();
    window.addEventListener("fire:records-updated", loadStats);
    return () => window.removeEventListener("fire:records-updated", loadStats);
  }, [goTo]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    try {
      setDark(localStorage.getItem(THEME_KEY) === "dark");
    } catch {
      /* 忽略存储异常 */
    }
  }, []);

  function toggleTheme() {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem(THEME_KEY, next ? "dark" : "light");
      } catch {
        /* 忽略存储异常 */
      }
      setThemeCookie(next);
      return next;
    });
  }

  // 登录状态确认前渲染占位，避免刷新闪现「登录」按钮
  if (!ready) {
    return <span aria-hidden className="inline-flex h-10 w-10 flex-none rounded-full bg-bg-gray/80 dark:bg-white/10" />;
  }

  if (!user) {
    if (initialUser) {
      return <span aria-hidden className="inline-flex h-10 w-10 flex-none rounded-full bg-bg-gray/80 dark:bg-white/10" />;
    }
    return (
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("fire:open-login"))}
        className="btn btn-brand btn-sm"
      >
        登录
      </button>
    );
  }

  async function logout() {
    setOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function go(tab: string, sub?: string) {
    setOpen(false);
    if (goTo) {
      if (tab === "settings" && sub === "profile") router.push("/settings?sub=profile");
      else if (tab === "settings") router.push("/settings");
      return;
    }
    window.dispatchEvent(new CustomEvent("fire:navigate", { detail: { tab, sub } }));
  }

  const displayName = user.nickname || user.username;

  return (
    <div className="relative" ref={rootRef} onMouseEnter={openSoon} onMouseLeave={closeSoon}>
      <button
        type="button"
        onClick={() => {
          if (goTo) {
            router.push(goTo);
            return;
          }
          setOpen((v) => !v);
        }}
        className={`group relative z-[60] flex items-center rounded-full p-0.5 transition-all duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] ${
          open ? "scale-[1.4]" : "hover:scale-[1.18]"
        }`}
        style={{ transformOrigin: "top center" }}
        aria-label="账号菜单"
        aria-expanded={open}
      >
        <span className="relative inline-flex">
          {user.avatar ? (
            <img src={user.avatar} alt={`${user.username} 头像`} className={`h-10 w-10 rounded-full object-cover shadow-[0_2px_10px_rgba(0,0,0,.2)] transition-shadow duration-300 ${open ? "ring-2 ring-white" : "ring-2 ring-white/80 group-hover:ring-white"}`} />
          ) : (
            <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-light text-[13px] font-bold text-brand-deep shadow-[0_2px_10px_rgba(0,0,0,.2)] transition-shadow duration-300 dark:bg-[#2b313c] dark:text-white ${open ? "ring-2 ring-white" : "ring-2 ring-white/80 group-hover:ring-white"}`}>
              {displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          {user.role === "admin" && (
            <img
              src="/icons/bolt.circle.fill.svg"
              alt="管理员"
              className="absolute -bottom-[1px] -right-[1px] h-[10px] w-[10px] rounded-full ring-[1px] ring-white transition-shadow duration-300 dark:ring-[#151a26]"
            />
          )}
        </span>
      </button>

      {open && (
        <div className="modal-panel absolute left-1/2 top-[29px] z-50 -ml-[136px] w-[272px] max-w-[calc(100vw-24px)] rounded-2xl border border-edge bg-white shadow-[0_14px_44px_rgba(10,14,25,.16)] dark:border-white/10 dark:bg-[#1c1c1e] max-[768px]:fixed max-[768px]:left-auto max-[768px]:right-3 max-[768px]:top-[72px] max-[768px]:ml-0 max-[768px]:w-[272px]">
          {/* B 站风格跨层头像：头像下半在卡片内、上半探出卡片上方，白边突出 */}
          <div className="px-4 pb-4 pt-10 text-center">
            <div className="min-w-0">
              <div className="flex items-center justify-center gap-1.5">
                <span className="truncate text-sm font-bold text-ink">{displayName}</span>
              </div>
              {/* 持股 / 自选股 数据（对应 B 站 关注/粉丝/动态） */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { label: "自选股", value: stats.watchlist },
                  { label: "持股", value: stats.holdings },
                  { label: "", value: "—" }
                ].map((s) => (
                  <div key={s.label} className="rounded-[10px] bg-bg-gray/60 px-1 py-1.5 dark:bg-white/5">
                    <div className="text-[15px] font-bold tabular-nums text-ink">{s.value}</div>
                    <div className="text-[10px] text-faint">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-1.5">
            <button
              type="button"
              onClick={() => go("settings", "profile")}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
              </svg>
              个人信息
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto h-4 w-4 text-faint">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => go("settings")}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
              </svg>
              设置
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto h-4 w-4 text-faint">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" />
                <path d="M2 12h2" /><path d="M20 12h2" /><path d="m4.9 19.1 1.4-1.4" /><path d="m17.7 6.3 1.4-1.4" />
              </svg>
              主题：{dark ? "深色" : "浅色"}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto h-4 w-4 text-faint">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="border-t border-edge p-1.5 dark:border-white/10">
            <TimeMachineLink to="simple" />
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
