"use client";

import { useEffect, useState } from "react";
import type { User } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { showToast } from "@/lib/toast";
import AppModal from "@/components/AppModal";
import DeleteIcon from "@/components/DeleteIcon";

interface AdminUser extends User {
  createdAt: string;
  recordsCount: number;
  online: boolean;
}

/** 模块级短缓存：进入用户管理秒开（5s 内复用，避免每次切页都整页「加载中」） */
let usersCache: { at: number; users: AdminUser[]; me: string } | null = null;
const USERS_CACHE_TTL = 5000;

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
  const [users, setUsers] = useState<AdminUser[]>(() => usersCache?.users ?? []);
  const [me, setMe] = useState<string>(() => usersCache?.me ?? "");
  const [loading, setLoading] = useState<boolean>(!usersCache);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(opts?: { force?: boolean }) {
    if (!opts?.force && usersCache && Date.now() - usersCache.at < USERS_CACHE_TTL) {
      setUsers(usersCache.users);
      setMe(usersCache.me);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error(res.status === 401 ? "登录已失效，请重新登录" : "用户列表加载失败");
      const data = await res.json();
      usersCache = { at: Date.now(), users: data.users, me: data.me };
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
    setMsg({ type: "ok", text: `已重置 ${resetUser.username} 的密码` });
    showToast("密码已重置");
  }

  async function removeUser(u: AdminUser) {
    if (!confirm(`确定删除用户「${u.username}」吗？该用户的记录、会话、操作日志会一并删除！`)) return;
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
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">用户管理</h2>
        </div>
        <button type="button" onClick={() => load({ force: true })} className="btn btn-ghost btn-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
          刷新
        </button>
      </div>

      {msg && (
        <p className={`mb-4 rounded-[10px] px-3.5 py-2.5 text-[13px] ${msg.type === "ok" ? "bg-brand-light text-brand-deep" : "bg-up-bg text-up"}`}>
          {msg.text}
        </p>
      )}

      <div className="overflow-hidden rounded-card border border-edge bg-white shadow-card">
        {loading && users.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-faint">
            <svg viewBox="0 0 24 24" fill="none" className="mr-2 h-4 w-4 animate-spin text-brand"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
            加载中…
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="mobile-users-table w-full text-sm">
            <thead>
              <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                <th className="px-4 py-[13px] text-left">用户</th>
                <th className="px-4 py-[13px] text-left">邮箱</th>
                <th className="px-4 py-[13px] text-left">角色</th>
                <th className="px-4 py-[13px] text-left">注册时间</th>
                <th className="px-4 py-[13px] text-right">记录数</th>
                <th className="px-4 py-[13px] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]">
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={u} />
                      <span>
                        <span className="flex items-center gap-1.5">
                          <b className="font-semibold">{u.username}</b>
                          {u.online && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-down-bg px-2 py-0.5 text-[11px] font-semibold text-down">
                              <span className="h-1.5 w-1.5 rounded-full bg-down shadow-[0_0_0_2px_rgba(15,160,123,.18)]" />
                              在线
                            </span>
                          )}
                        </span>
                        {u.nickname && <span className="ml-1.5 text-xs text-muted">({u.nickname})</span>}
                        {u.id === me && <span className="ml-1.5 rounded-full bg-brand-light px-2 py-0.5 text-[11px] font-semibold text-brand-deep">当前账号</span>}
                        {u.isTest && <span className="ml-1.5 rounded-full border border-dashed border-edge-strong bg-bg-gray px-2 py-0.5 text-[11px] font-semibold text-muted">测试</span>}
                        <small className="block text-[11px] text-faint">{u.isTest ? "测试账号 · 不占用 UID" : `UID: ${u.uid || "—"}`}</small>
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-muted">{u.email || <span className="text-faint">—</span>}</td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-block rounded-full border px-2.5 py-[3px] text-xs ${u.role === "admin" ? "border-edge-strong/30 bg-brand-light text-brand-deep" : "border-edge bg-bg-gray text-ink-2"}`}>
                      {u.role === "admin" ? "管理员" : "普通用户"}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-xs text-muted">{fmtDateTime(u.createdAt)}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums">{u.recordsCount}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex justify-end gap-1.5">
                      <button type="button" onClick={() => setEditUser(u)} className="inline-flex h-8 items-center rounded-[9px] border border-edge bg-white px-3 text-xs font-medium text-muted transition-colors hover:bg-brand-hover hover:text-ink">编辑</button>
                      <button type="button" onClick={() => setResetUser(u)} className="inline-flex h-8 items-center rounded-[9px] border border-edge bg-white px-3 text-xs font-medium text-muted transition-colors hover:bg-brand-hover hover:text-ink">重置密码</button>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              <select name="role" defaultValue={editUser.role} className="field">
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
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
