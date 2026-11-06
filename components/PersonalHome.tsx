"use client";
import type { User } from "@/lib/types";
export default function PersonalHome({ user, onEdit }: {
    user: User;
    onEdit: () => void;
}) {
    const name = user.nickname || user.username;
    return <section className="personal-home" aria-label="个人主页">
    <header>{user.avatar ? <img src={user.avatar} alt={`${name} 头像`}/> : <span className="personal-home-avatar">{name.slice(0, 1)}</span>}<h1>{name}</h1><p>@{user.username}</p><button type="button" className="personal-edit" data-capsule="off" onClick={onEdit}>编辑资料</button></header>
    <div className="personal-home-stats">{["累计请求", "活跃天数", "最长连续", "当前连续"].map(label => <div key={label}><strong>—</strong><span>{label}</span></div>)}</div>
    <section className="personal-request-history"><h2>API 请求次数</h2><div role="status">当前服务暂无按本人区分的请求统计</div></section>
  </section>;
}
