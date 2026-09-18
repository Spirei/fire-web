"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import type { User } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { showToast } from "@/lib/toast";
import AppModal from "@/components/AppModal";
import DeleteIcon from "@/components/DeleteIcon";
import AppSelect from "@/components/AppSelect";
import { appConfirm, appPrompt } from "@/lib/appDialog";

interface AdminUser extends User {
  createdAt: string;
  recordsCount: number;
  online: boolean;
  totpEnabled?: boolean;
}

/** 模块级短缓存：进入用户管理秒开（5s 内复用，避免每次切页都整页「加载中」） */
let usersCache: { at: number; users: AdminUser[]; me: string } | null = null;
const USERS_CACHE_TTL = 5000;
const USERS_SESSION_KEY = "fire:users-cache-v1";

function readUsersSession(): { users: AdminUser[]; me: string; fresh: boolean } | null {
  if (usersCache && Date.now() - usersCache.at < USERS_CACHE_TTL) {
    return { users: usersCache.users, me: usersCache.me, fresh: true };
  }
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(USERS_SESSION_KEY) || "null") as { users?: AdminUser[]; me?: string } | null;
    if (parsed && Array.isArray(parsed.users) && parsed.users.length > 0) {
      return { users: parsed.users, me: parsed.me || "", fresh: false };
    }
  } catch {
    /* 忽略损坏缓存 */
  }
  return null;
}

function writeUsersSession(users: AdminUser[], me: string) {
  usersCache = { at: Date.now(), users, me };
  try {
    sessionStorage.setItem(USERS_SESSION_KEY, JSON.stringify({ users, me }));
  } catch {
    /* 忽略存储异常 */
  }
}

function UserAvatar({ user, size = "md" }: { user: Pick<User, "username" | "avatar" | "role">; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-[13px]";
  const badgeCls = size === "sm" ? "h-[8px] w-[8px] -bottom-[1px] -right-[1px] ring-[0.5px]" : "h-[10px] w-[10px] -bottom-[1px] -right-[1px] ring-[1px]";
  return (
    <span className="relative inline-flex flex-none">
      {user.avatar ? (
        <img src={user.avatar} alt="" className={`${cls} rounded-full object-cover`} />
      ) : (
        <span className={`${cls} inline-flex items-center justify-center rounded-full bg-brand-light font-bold text-brand-deep`}>
          {user.username.slice(0, 1).toUpperCase()}
        </span>
      )}
      {user.role === "admin" && (
        <img
          src="/icons/bolt.circle.fill.svg"
          alt="管理员"
          className={`absolute ${badgeCls} rounded-full ring-white dark:ring-[#151a26]`}
        />
      )}
    </span>
  );
}

export default function UsersView() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [me, setMe] = useState("");
  const [loading, setLoading] = useState(true);

  useLayoutEffect(() => {
    const cached = readUsersSession();
    if (!cached) return;
    setUsers(cached.users);
    setMe(cached.me);
    setLoading(false);
  }, []);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const onlineCount = users.filter((u) => u.online).length;
  const adminCount = users.filter((u) => u.role === "admin").length;

  async function load(opts?: { force?: boolean }) {
    const cached = readUsersSession();
    if (cached) {
      setUsers(cached.users);
      setMe(cached.me);
      setLoading(false);
      if (!opts?.force && cached.fresh) return;
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error(res.status === 401 ? "登录已失效，请重新登录" : "用户列表加载失败");
      const data = await res.json();
      writeUsersSession(data.users, data.me);
      setUsers(data.users);
      setMe(data.me);
      if (opts?.force) setMsg({ type: "ok", text: "用户列表已刷新" });
    } catch (error) {
      setMsg({ type: "err", text: error instanceof Error ? error.message : "用户列表加载失败，请重试" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(timer);
  }, []);

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.target as HTMLFormElement);
    const res = await fetch(`/api/users/${editUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: String(fd.get("username") ?? ""),
        email: String(fd.get("email") ?? ""),
        role: String(fd.get("role") ?? "user")
      })
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setMsg({ type: "err", text: data?.error || "保存失败" });
      return;
    }
    setEditUser(null);
    setMsg({ type: "ok", text: "用户信息已更新" });
    showToast("用户信息已更新");
    load({ force: true });
  }

  async function doResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetUser) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.target as HTMLFormElement);
    const pw = String(fd.get("newPassword") ?? "");
    const res = await fetch(`/api/users/${resetUser.id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: pw })
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setMsg({ type: "err", text: data?.error || "重置失败" });
      return;
    }
    setResetUser(null);
    setMsg({ type: "ok", text: `已重置 ${resetUser.username} 的密码${data?.totpDisabled ? "，并关闭二次验证" : ""}` });
    showToast(data?.totpDisabled ? "密码已重置，二次验证已关闭" : "密码已重置");
  }

  async function disableUserTotp(u: AdminUser) {
    if (!await appConfirm(`关闭「${u.username}」的二次验证？该用户下次登录将不再需要验证码。`, { title: "关闭二次验证", danger: true })) return;
    const password = await appPrompt("请输入你的管理员密码以继续", { title: "安全验证", placeholder: "当前密码" });
    if (!password) return;
    setMsg(null);
    const res = await fetch(`/api/users/${u.id}/disable-totp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg({ type: "err", text: data?.error || "关闭失败" });
      return;
    }
    setMsg({ type: "ok", text: `已关闭 ${u.username} 的二次验证` });
    showToast("二次验证已关闭");
    load({ force: true });
  }

  async function removeUser(u: AdminUser) {
    if (!await appConfirm(`确定删除用户「${u.username}」吗？该用户的记录、会话、操作日志会一并删除！`, { title: "删除用户", danger: true })) return;
    setMsg(null);
    const res = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg({ type: "err", text: data?.error || "删除失败" });
      return;
    }
    setMsg({ type: "ok", text: `已删除用户 ${u.username}` });
    showToast(`已删除用户 ${u.username}`);
    load({ force: true });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-[-0.02em]">用户管理</h2>
          <div className="mt-2 flex items-center gap-3 text-xs text-muted">
            <span><b className="mr-1 font-semibold text-ink">{users.length}</b>位用户</span>
            <span className="h-3 w-px bg-edge" />
            <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-down" /><b className="font-semibold text-ink">{onlineCount}</b>在线</span>
            <span className="h-3 w-px bg-edge" />
            <span><b className="mr-1 font-semibold text-ink">{adminCount}</b>管理员</span>
          </div>
        </div>
        <button type="button" onClick={() => load({ force: true })} disabled={loading} aria-label="刷新用户列表" title="刷新用户列表" className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-edge bg-white text-muted transition-colors hover:bg-brand-hover hover:text-ink disabled:opacity-50 dark:bg-[#151a26] dark:hover:bg-white/10">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>

      {msg && (
        <p className={`mb-4 rounded-[10px] px-3.5 py-2.5 text-[13px] ${msg.type === "ok" ? "bg-brand-light text-brand-deep" : "bg-up-bg text-up"}`}>
          {msg.text}
        </p>
      )}

      <div className="overflow-hidden rounded-[16px] border border-edge bg-white shadow-card dark:bg-[#151a26]">
        {loading && users.length === 0 ? (
          <div className="space-y-2 p-4" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-[12px] bg-bg-gray" />
            ))}
          </div>
        ) : (
        <div>
          <div className="hidden grid-cols-[minmax(220px,1.5fr)_minmax(170px,1fr)_100px_140px_64px_148px] items-center gap-4 border-b border-edge bg-bg-gray/65 px-4 py-2.5 text-[11px] font-semibold text-muted lg:grid dark:bg-white/[.025]">
            <span>用户</span><span>邮箱</span><span>权限</span><span>注册时间</span><span className="text-right">记录</span><span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-edge">
              {users.map((u) => (
                <div key={u.id} className="grid gap-3 px-4 py-3.5 transition-colors hover:bg-[#fafbfc] sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(220px,1.5fr)_minmax(170px,1fr)_100px_140px_64px_148px] lg:items-center lg:gap-4 dark:hover:bg-[#1a212e]">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <UserAvatar user={u} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <b className="truncate font-semibold text-ink">{u.nickname || u.username}</b>
                          {u.online && <span className="h-1.5 w-1.5 flex-none rounded-full bg-down shadow-[0_0_0_3px_rgba(15,160,123,.12)]" title="在线" />}
                          {u.id === me && <span className="flex-none rounded-full bg-brand-light px-2 py-0.5 text-[10px] font-semibold text-brand-deep">当前</span>}
                          {u.totpEnabled && <span className="flex-none rounded-full border border-edge px-2 py-0.5 text-[10px] font-semibold text-ink-2">二次验证</span>}
                          {u.isTest && <span className="flex-none rounded-full border border-dashed border-edge px-2 py-0.5 text-[10px] font-semibold text-muted">测试</span>}
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
                          {u.nickname && <span className="truncate">@{u.username}</span>}
                          {u.nickname && <span>·</span>}
                          <span className="flex-none">{u.isTest ? "无 UID" : `UID ${u.uid || "—"}`}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0 text-xs text-muted sm:col-span-2 lg:col-span-1"><span className="lg:hidden text-faint">邮箱 · </span><span className="break-all">{u.email || "未绑定"}</span></div>
                  <div className="sm:col-start-2 sm:row-start-1 sm:self-start sm:justify-self-end lg:col-start-auto lg:row-start-auto lg:self-auto lg:justify-self-start">
                    <span className={`inline-flex rounded-full border px-2.5 py-[3px] text-[11px] font-medium ${u.role === "admin" ? "border-edge-strong/30 bg-brand-light text-brand-deep" : "border-edge bg-bg-gray text-ink-2 dark:bg-white/[.04]"}`}>
                      {u.role === "admin" ? "管理员" : "普通用户"}
                    </span>
                  </div>
                  <div className="text-[11px] text-faint"><span className="lg:hidden">注册于 </span>{fmtDateTime(u.createdAt)}</div>
                  <div className="text-xs tabular-nums text-muted lg:text-right"><span className="lg:hidden">{u.recordsCount} 条记录</span><span className="hidden lg:inline">{u.recordsCount}</span></div>
                  <div className="flex gap-1.5 sm:col-start-2 sm:row-start-3 sm:justify-self-end lg:col-start-auto lg:row-start-auto lg:justify-end">
                      <button type="button" onClick={() => setEditUser(u)} aria-label={`编辑 ${u.username}`} title="编辑资料" className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-white text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:bg-[#1c222d] dark:hover:bg-white/10"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
                      <button type="button" onClick={() => setResetUser(u)} aria-label={`重置 ${u.username} 的密码`} title="重置密码" className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-white text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:bg-[#1c222d] dark:hover:bg-white/10"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/><circle cx="12" cy="12" r="2.25"/><path d="m13.6 13.6 2.4 2.4"/></svg></button>
                      {u.totpEnabled && (
                        <button type="button" onClick={() => disableUserTotp(u)} aria-label={`关闭 ${u.username} 的二次验证`} title="关闭二次验证" className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-white text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:bg-[#1c222d] dark:hover:bg-white/10">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 3a9 9 0 0 0-9 9c0 4.2 3 7.7 7 8.7V13H8v-3h2V8.5A3.5 3.5 0 0 1 13.5 5H16v3h-2.2c-.4 0-.8.4-.8.8V10h3l-.4 3H13v7.7c4-.9 7-4.5 7-8.7a9 9 0 0 0-8-8.9Z"/><path d="m4 4 16 16"/></svg>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={u.id === me}
                        onClick={() => removeUser(u)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-white bg-bg-gray text-muted transition-colors hover:bg-brand-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/20 dark:bg-[#1c222d] dark:text-white/70 dark:hover:border-white/40 dark:hover:bg-white/10 dark:hover:text-white"
                        title={u.id === me ? "不能删除自己的账号" : "删除用户"}
                      >
                        <DeleteIcon size={15} />
                      </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
        )}
      </div>

      {/* 编辑弹窗 */}
      {editUser && (
        <AppModal title="编辑用户" desc={`修改「${editUser.username}」的资料`} onClose={() => setEditUser(null)}>
          <form onSubmit={saveEdit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
              用户名
              <input name="username" defaultValue={editUser.username} required className="field" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
              邮箱
              <input name="email" type="email" defaultValue={editUser.email} placeholder="选填" className="field" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
              角色
              <input type="hidden" name="role" value={editUser.role} />
              <AppSelect value={editUser.role} onChange={(role) => setEditUser((current) => current ? { ...current, role: role as "user" | "admin" } : current)} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} className="field" ariaLabel="角色" />
            </label>
            <div className="mt-1 flex justify-end gap-2.5 border-t border-edge pt-4">
              <button type="button" onClick={() => setEditUser(null)} className="btn btn-ghost btn-sm">取消</button>
              <button type="submit" disabled={busy} className="btn btn-line btn-sm disabled:opacity-60">{busy ? "保存中…" : "保存"}</button>
            </div>
          </form>
        </AppModal>
      )}

      {/* 重置密码弹窗 */}
      {resetUser && (
        <AppModal title="重置密码" desc={`为「${resetUser.username}」设置新密码`} onClose={() => setResetUser(null)}>
          <form onSubmit={doResetPassword} className="flex flex-col gap-4">
            {resetUser.totpEnabled && (
              <p className="rounded-[10px] bg-bg-gray px-3.5 py-2.5 text-[13px] text-muted">重置密码会同时关闭该用户的二次验证。</p>
            )}
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
              新密码（至少 8 位，含字母和数字）
              <input name="newPassword" type="password" required minLength={6} className="field" />
            </label>
            <div className="mt-1 flex justify-end gap-2.5 border-t border-edge pt-4">
              <button type="button" onClick={() => setResetUser(null)} className="btn btn-ghost btn-sm">取消</button>
              <button type="submit" disabled={busy} className="btn btn-line btn-sm disabled:opacity-60">{busy ? "提交中…" : "确认重置"}</button>
            </div>
          </form>
        </AppModal>
      )}
    </div>
  );
}
