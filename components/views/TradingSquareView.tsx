"use client";

import { useEffect, useState } from "react";

type Post = { id: string; date: string; text: string; textZh?: string; originalUrl: string; archiveUrl: string };

export default function TradingSquareView() {
  const [showOriginal, setShowOriginal] = useState(false);
  const [following, setFollowing] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetch("/api/trading-square/trump").then((response) => response.json()).then((data) => setPosts(data.posts ?? [])).catch(() => setPosts([])).finally(() => setLoading(false)); }, []);
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div><h1 className="text-xl font-bold text-ink dark:text-white">交易广场</h1><p className="mt-1 text-xs text-muted">关注市场人物的公开动态</p></div>
      <section className="overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-edge px-5 py-5"><div className="flex items-center gap-3"><img src="/uploads/celebs/trump-custom-1786043526485-1e34c87e.png" alt="特朗普" className="h-12 w-12 rounded-full object-cover" /><div><h2 className="text-base font-bold text-ink dark:text-white">特朗普</h2><p className="text-xs text-muted">@realDonaldTrump · Truth Social</p></div></div><button type="button" onClick={() => setFollowing((value) => !value)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${following ? "bg-bg-gray text-muted" : "bg-ink text-white dark:bg-white dark:text-ink"}`}>{following ? "已关注" : "关注"}</button></div>
        <div className="divide-y divide-edge">{loading ? <div className="px-5 py-10 text-center text-sm text-muted">正在同步公开归档…</div> : posts.length === 0 ? <div className="px-5 py-10 text-center text-sm text-muted">暂时没有可用动态</div> : posts.map((post) => <article key={post.id} className="px-5 py-5"><div className="flex items-center justify-between text-xs text-faint"><span>特朗普今日说了什么</span><time>{new Date(post.date).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><p className="mt-3 whitespace-pre-line text-[15px] leading-7 text-ink dark:text-slate-200">{showOriginal ? post.text : (post.textZh ?? post.text)}</p><div className="mt-5 flex items-center justify-between border-t border-edge pt-3 text-xs text-muted"><span>公开归档 · {new Date(post.date).getFullYear()}</span><div className="flex gap-4"><a href={post.originalUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-deep hover:underline">查看原文 ↗</a><button type="button" onClick={() => setShowOriginal((value) => !value)} className="font-semibold hover:text-ink dark:hover:text-white">{showOriginal ? "中文" : "原文"}</button></div></div></article>)}</div>
      </section>
    </div>
  );
}
