"use client";

import { useState } from "react";

export default function TradingSquareView() {
  const [translated, setTranslated] = useState(false);
  const [following, setFollowing] = useState(false);
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div><h1 className="text-xl font-bold text-ink dark:text-white">交易广场</h1><p className="mt-1 text-xs text-muted">关注市场人物的公开动态</p></div>
      <section className="overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-edge px-5 py-5"><div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-full bg-[#c74335] text-xl font-bold text-white">T</div><div><h2 className="text-base font-bold text-ink dark:text-white">特朗普</h2><p className="text-xs text-muted">@realDonaldTrump · Truth Social</p></div></div><button type="button" onClick={() => setFollowing((value) => !value)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${following ? "bg-bg-gray text-muted" : "bg-ink text-white dark:bg-white dark:text-ink"}`}>{following ? "已关注" : "关注"}</button></div>
        <article className="px-5 py-5"><div className="flex items-center justify-between text-xs text-faint"><span>特朗普今日说了什么</span><span>刚刚</span></div><p className="mt-3 text-[15px] leading-7 text-ink dark:text-slate-200">{translated ? "特朗普的公开动态将在 Truth Social 更新后显示。" : "特朗普今日动态将在 Truth Social 更新后显示。"}</p><div className="mt-5 flex items-center justify-between border-t border-edge pt-3 text-xs text-muted"><div className="flex gap-5"><span>评论</span><span>转发</span><span>赞</span></div><div className="flex gap-4"><a href="https://truthsocial.com/@realDonaldTrump" target="_blank" rel="noreferrer" className="font-semibold text-brand-deep hover:underline">查看原文 ↗</a><button type="button" onClick={() => setTranslated((value) => !value)} className="font-semibold hover:text-ink dark:hover:text-white">{translated ? "原文" : "翻译"}</button></div></div></article>
      </section>
    </div>
  );
}
