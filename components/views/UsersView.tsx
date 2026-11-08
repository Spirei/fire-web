"use client";

import { IconPencil, IconKey, IconShieldLock, IconFingerprint } from "@tabler/icons-react";
import { CapsuleBadge, IconButton, Capsule } from "@/components/Capsule";
import PasswordInput from "@/components/PasswordInput";

import { useEffect, useLayoutEffect, useState } from "react";
import type { User } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { showToast } from "@/lib/toast";
import AppModal from "@/components/AppModal";
import DeleteIcon from "@/components/DeleteIcon";
import AppSelect from "@/components/AppSelect";
import AdminBadge from "@/components/AdminBadge";
import { appConfirm, appPrompt } from "@/lib/appDialog";
import { useWorkspaceActive } from "@/lib/workspacePanel";

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

function readUsersSession(ownerId: string): { users: AdminUser[]; me: string; fresh: boolean } | null {
  if (usersCache && usersCache.me === ownerId && Date.now() - usersCache.at < USERS_CACHE_TTL) {
    return { users: usersCache.users, me: usersCache.me, fresh: true };
  }
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(USERS_SESSION_KEY + ":" + ownerId) || "null") as { users?: AdminUser[]; me?: string } | null;
    if (parsed && Array.isArray(parsed.users) && parsed.users.length > 0 && parsed.me === ownerId) {
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
    sessionStorage.setItem(USERS_SESSION_KEY + ":" + me, JSON.stringify({ users, me }));
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
        <AdminBadge
          className={`absolute ${badgeCls} rounded-full ring-white dark:ring-[#151a26]`}
        />
      )}
    </span>
  );
}

export default function UsersView({ownerId = "", initial}:{ownerId?:string;initial?:import("@/lib/workspaceInitial").WorkspaceInitial["users"]}) {
  const active = useWorkspaceActive();
  const [users, setUsers] = useState<AdminUser[]>(initial?.users ?? []);
  const [me, setMe] = useState(initial?.me ?? "");
  const [loading, setLoading] = useState(!initial);

  useLayoutEffect(() => {
    if (initial) { writeUsersSession(initial.users, initial.me); return; }
    const cached = readUsersSession(ownerId);
    if (!cached) return;
    setUsers(cached.users);
    setMe(cached.me);
    setLoading(false);
  }, []);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [passkeyUser,setPasskeyUser]=useState<AdminUser|null>(null);
  const [passkeyKeys,setPasskeyKeys]=useState<{id:string;name:string;rpID:string;createdAt:number;lastUsedAt:number|null}[]|null>(null);
  const [passkeyError,setPasskeyError]=useState("");
  useEffect(()=>{if(!passkeyUser)return;const c=new AbortController();setPasskeyKeys(null);setPasskeyError("");fetch(`/api/users/${encodeURIComponent(passkeyUser.id)}/passkeys`,{signal:c.signal,cache:"no-store"}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||"读取失败");return d;}).then(d=>{if(!c.signal.aborted)setPasskeyKeys(d.keys);}).catch(e=>{if(!c.signal.aborted)setPasskeyError(e.message);});return()=>c.abort();},[passkeyUser]);
  const [busy, setBusy] = useState(false);
  const onlineCount = users.filter((u) => u.online).length;
  const adminCount = users.filter((u) => u.role === "admin").length;

  async function load(opts?: { force?: boolean }) {
    const cached = readUsersSession(ownerId);
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
      if (data.me !== ownerId) throw new Error("登录身份已变化，请刷新页面");
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
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [active]);

  async function requestAdminStepUp(): Promise<{ currentPassword: string; code: string } | null> {
    const currentPassword = await appPrompt("请输入你的管理员密码以继续", { title: "安全验证", inputType: "password" });
    if (!currentPassword) return null;
    const currentAdmin = users.find((item) => item.id === me);
    const code = currentAdmin?.totpEnabled
      ? await appPrompt("请输入管理员二次验证码或备用码", { title: "二次验证", placeholder: "6 位数字或备用码" })
      : "";
    if (currentAdmin?.totpEnabled && !code) return null;
    return { currentPassword, code: code || "" };
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.target as HTMLFormElement);
    const nextRole = String(fd.get("role") ?? "user");
    const previousRole = users.find((item) => item.id === editUser.id)?.role;
    const stepUp = previousRole !== nextRole ? await requestAdminStepUp() : null;
    if (previousRole !== nextRole && !stepUp) { setBusy(false); return; }
    const res = await fetch(`/api/users/${editUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: String(fd.get("username") ?? ""),
        email: String(fd.get("email") ?? ""),
        role: nextRole,
        ...stepUp
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
    const stepUp = await requestAdminStepUp();
    if (!stepUp) { setBusy(false); return; }
    const res = await fetch(`/api/users/${resetUser.id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: pw, ...stepUp })
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setMsg({ type: "err", text: data?.error || "重置失败" });
      return;
    }
    setResetUser(null);
    setMsg({ type: "ok", text: `已重置 ${resetUser.username} 的密码，二次验证、通行密钥与原有会话已撤销` });
    showToast(data?.passkeysRevoked ? "密码已重置，二次验证和通行密钥已撤销" : "密码已重置");
  }

  async function disableUserTotp(u: AdminUser) {
    if (!await appConfirm(`关闭「${u.username}」的二次验证？该用户下次登录将不再需要验证码。`, { title: "关闭二次验证", danger: true })) return;
    const stepUp = await requestAdminStepUp();
    if (!stepUp) return;
    setMsg(null);
    const res = await fetch(`/api/users/${u.id}/disable-totp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stepUp)
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
    const stepUp = await requestAdminStepUp();
    if (!stepUp) return;
    setMsg(null);
    const res = await fetch(`/api/users/${u.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stepUp)
    });
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
    <div className="users-page">
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
        <IconButton size="md" framed type="button" onClick={() => load({ force: true })} disabled={loading} label="刷新用户列表" title="刷新用户列表" className="">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
        </IconButton>
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
          <div className="users-table-head">
            <span>用户</span><span>邮箱</span><span>权限</span><span>注册时间</span><span className="text-right">记录</span><span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-edge">
              {users.map((u) => (
                <div key={u.id} className="users-table-row">
                  <div className="users-identity min-w-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <UserAvatar user={u} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <b className="truncate font-semibold text-ink">{u.nickname || u.username}</b>
                          {u.online && <span className="h-1.5 w-1.5 flex-none rounded-full bg-down shadow-[0_0_0_3px_rgba(15,160,123,.12)]" title="在线" />}
                          {u.id === me && <CapsuleBadge className="user-current-pill">当前</CapsuleBadge>}
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
                  <div className="users-email min-w-0 text-xs text-muted"><span className="users-mobile-label text-faint">邮箱 · </span><span className="break-all">{u.email || "未绑定"}</span></div>
                  <div className="users-role">
                    <CapsuleBadge className="user-role-pill">{u.role === "admin" ? "管理员" : "普通用户"}</CapsuleBadge>
                  </div>
                  <div className="users-created text-[11px] text-faint"><span className="users-mobile-label">注册于 </span>{fmtDateTime(u.createdAt)}</div>
                  <div className="users-records text-xs tabular-nums text-muted"><span>{u.recordsCount}<span className="users-mobile-label"> 条记录</span></span></div>
                  <div className="users-actions" role="group" aria-label={`${u.nickname || u.username}的操作`}>
                    <IconButton size="sm" framed label={`编辑 ${u.username}`} title="编辑资料" onClick={() => setEditUser(u)}><IconPencil size={17} stroke={1.7}/></IconButton>
                    <IconButton size="sm" framed label={`重置 ${u.username} 的密码`} title="重置密码" onClick={() => setResetUser(u)}><IconKey size={17} stroke={1.7}/></IconButton>
                    <IconButton size="sm" framed label={`关闭 ${u.username} 的二次验证`} title="关闭二次验证" disabled={!u.totpEnabled} onClick={() => disableUserTotp(u)}><IconShieldLock size={17} stroke={1.7}/></IconButton>
                    <IconButton size="sm" framed label={`查看 ${u.username} 的通行密钥`} title="通行密钥" onClick={() => { setPasskeyKeys(null); setPasskeyError(""); setPasskeyUser(u); }}><IconFingerprint size={18} stroke={1.7}/></IconButton>
                    <IconButton size="sm" framed label={`删除用户 ${u.username}`} title={u.id === me ? "不能删除自己的账号" : "删除用户"} disabled={u.id === me} onClick={() => removeUser(u)}><DeleteIcon size={16}/></IconButton>
                  </div>
                </div>
              ))}
          </div>
        </div>
        )}
      </div>

      {passkeyUser&&<AppModal title={`${passkeyUser.nickname||passkeyUser.username}的通行密钥`} onClose={()=>setPasskeyUser(null)}>{passkeyError?<p role="alert">{passkeyError}</p>:passkeyKeys===null?<p role="status">正在读取</p>:passkeyKeys.length?passkeyKeys.map(k=><div key={k.id} className="user-passkey-row"><IconFingerprint size={20}/><div><strong>{k.name||"通行密钥"}</strong><small>{k.rpID}</small><small>创建于 {fmtDateTime(new Date(k.createdAt).toISOString())}</small></div></div>):<p>尚未添加通行密钥</p>}{passkeyUser.id===me&&<Capsule variant="secondary" className="" type="button" onClick={()=>{setPasskeyUser(null);window.dispatchEvent(new CustomEvent("fire:navigate",{detail:{tab:"settings",sub:"passkeys"}}));}}>管理我的通行密钥</Capsule>}</AppModal>}
      {/* 编辑弹窗 */}
      {editUser && (
        <AppModal closeDisabled={busy} title="编辑用户" desc={`修改「${editUser.username}」的资料`} onClose={() => setEditUser(null)}>
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
              <Capsule variant="ghost" size="sm" type="button" onClick={() => setEditUser(null)} className="">取消</Capsule>
              <Capsule variant="primary" size="sm" type="submit" disabled={busy} className="disabled:opacity-60">{busy ? "保存中…" : "保存"}</Capsule>
            </div>
          </form>
        </AppModal>
      )}

      {/* 重置密码弹窗 */}
      {resetUser && (
        <AppModal closeDisabled={busy} title="重置密码" desc={`为「${resetUser.username}」设置新密码`} onClose={() => setResetUser(null)}>
          <form onSubmit={doResetPassword} className="flex flex-col gap-4">
            <p className="rounded-[10px] bg-bg-gray px-3.5 py-2.5 text-[13px] text-muted">重置密码会同时撤销该用户的二次验证、通行密钥和所有登录会话。</p>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
              新密码（至少 8 位，含字母和数字）
              <PasswordInput name="newPassword" type="password" required minLength={8} autoComplete="new-password" className="field" />
            </label>
            <div className="mt-1 flex justify-end gap-2.5 border-t border-edge pt-4">
              <Capsule variant="ghost" size="sm" type="button" onClick={() => setResetUser(null)} className="">取消</Capsule>
              <Capsule variant="primary" size="sm" type="submit" disabled={busy} className="disabled:opacity-60">{busy ? "提交中…" : "确认重置"}</Capsule>
            </div>
          </form>
        </AppModal>
      )}
    </div>
  );
}
