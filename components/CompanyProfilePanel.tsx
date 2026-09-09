"use client";

import { useEffect, useRef, useState } from "react";
import MarketCodeBadge from "@/components/MarketCodeBadge";

interface Props { market: string; code: string; name: string; iconUrl?: string }
interface Profile {
  supported?: boolean; source?: string; company?: string; symbol?: string; exchange?: string; founded?: string;
  industry?: string; fiscalYearEnd?: string; website?: string; description?: string; address?: string; phone?: string; error?: string;
}

const profileCache = new Map<string, Profile>();
const profileRequests = new Map<string, Promise<Profile>>();

function loadCompanyProfile(market: string, code: string) {
  const key = `${market.toUpperCase()}:${code.toUpperCase()}`;
  const cached = profileCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = profileRequests.get(key);
  if (pending) return pending;
  const request = fetch(`/api/v1/company-profile?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`)
    .then((response) => response.json())
    .then((result) => {
      const profile = result?.data || { error: result?.message || "公司资料加载失败" };
      profileCache.set(key, profile);
      return profile;
    })
    .catch(() => ({ error: "公司资料加载失败" } as Profile))
    .finally(() => profileRequests.delete(key));
  profileRequests.set(key, request);
  return request;
}

export function preloadCompanyProfile(market: string, code: string) {
  void loadCompanyProfile(market, code);
}

export default function CompanyProfilePanel({ market, code, name, iconUrl }: Props) {
  const cacheKey = `${market.toUpperCase()}:${code.toUpperCase()}`;
  const [profile, setProfile] = useState<Profile | null>(() => profileCache.get(cacheKey) || null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null); setExpanded(false);
    const cached = profileCache.get(`${market.toUpperCase()}:${code.toUpperCase()}`);
    if (cached) { setProfile(cached); return () => { cancelled = true; }; }
    loadCompanyProfile(market, code).then((data) => { if (!cancelled) setProfile(data); });
    return () => { cancelled = true; };
  }, [market, code]);

  useEffect(() => {
    const element = descriptionRef.current;
    if (!element || !profile?.description) { setCanExpand(false); return; }
    const measure = () => {
      if (expanded) return;
      setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [profile?.description, expanded]);

  if (!profile) return <div className="company-profile-state">正在加载公司简况…</div>;
  if (profile.error || profile.supported === false) return <div className="company-profile-state">{profile.error || "暂无公司简况"}</div>;

  const details = [
    ["公司名称", profile.company || name], ["所属市场", profile.exchange || "—"],
    ["成立日期", profile.founded || "—"], ["所属行业", profile.industry || "—"],
    ["年结日", profile.fiscalYearEnd || "—"], ["公司网址", profile.website || "—"]
  ];
  return <section className="company-profile-panel">
    <div className="company-profile-heading"><h3>公司简介</h3><span>{profile.source}</span></div>
    <div className="company-profile-intro">
      <div className="company-profile-brand">
        {iconUrl ? <img src={iconUrl} alt="" /> : <span>{name.slice(0, 1)}</span>}
        <div><b>{name}</b><small className="flex items-center gap-1.5"><MarketCodeBadge market={market} code={code} />{profile.symbol || `${code}.${market}`}</small></div>
      </div>
      <p ref={descriptionRef} className={expanded ? "is-expanded" : ""}>{profile.description}</p>
      {canExpand && <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "…更多"}</button>}
    </div>
    <div className="company-profile-heading company-info-heading"><h3>公司信息</h3></div>
    <dl className="company-profile-grid">
      {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "公司网址" && value !== "—" ? <a href={value} target="_blank" rel="noreferrer">{value.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a> : value}</dd></div>)}
    </dl>
  </section>;
}
