"use client";

import { IconWindmill } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import type { FeedPerson } from "@/lib/feedTypes";
import SafeAssetImage from "./SafeAssetImage";
import FeedPersonBadge, { feedPersonBadgeColor } from "./FeedPersonBadge";

export default function FeedPeopleFilter({profiles,selected,unread,onSelect}:{profiles:FeedPerson[];selected:string;unread:Record<string,boolean>;onSelect:(id:string)=>void}) {
  return <nav className="feed-people-filter" aria-label="人物筛选">
    <button type="button" data-capsule="off" aria-label="全部动态" aria-pressed={!selected} onClick={()=>onSelect("")}><span className="feed-filter-avatar feed-filter-all"><IconWindmill size={38} stroke={1.65}/></span><span className="feed-filter-name">全部动态</span></button>
    {profiles.map(person=><button type="button" data-capsule="off" key={person.id} style={{"--feed-filter-accent":feedPersonBadgeColor(person.id)} as CSSProperties} aria-label={person.name} aria-pressed={selected===person.id} onClick={()=>onSelect(person.id)}><span className="feed-filter-avatar"><SafeAssetImage src={person.avatar} alt={person.name} className="feed-filter-image" fallback={<span className="feed-filter-image feed-person-avatar-fallback">{person.name.slice(0,1)}</span>}/>{unread[person.id]&&<span className="feed-filter-unread" aria-label={`${person.name}有新动态`}/>}</span><span className="feed-filter-name">{person.name}<FeedPersonBadge personId={person.id}/></span></button>)}
  </nav>;
}
