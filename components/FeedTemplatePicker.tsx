"use client";

import { IconCheck } from "@tabler/icons-react";
import { FEED_PEOPLE } from "@/lib/feedPeopleConfig";
import type { FeedMode, FeedPersonId } from "@/lib/feedTypes";

export default function FeedTemplatePicker({mode,people,onMode,onPeople,disabled=false}:{mode:FeedMode;people:FeedPersonId[];onMode:(mode:FeedMode)=>void;onPeople:(people:FeedPersonId[])=>void;disabled?:boolean}) {
  return <div className="feed-template-picker">
    <span className="feed-config-label">动态模板</span>
    <div className="feed-template-options" role="group" aria-label="动态模板">{([{id:"news",name:"新闻动态",note:"按指示搜集新闻、提炼重点"},{id:"people",name:"名人原帖",note:"直接追踪本人发言，保留原文和配图"}] as const).map(template=><button key={template.id} type="button" data-capsule="off" aria-pressed={mode===template.id} disabled={disabled} onClick={()=>onMode(template.id)}><strong>{template.name}</strong><small>{template.note}</small></button>)}</div>
    {mode==="people"&&<><span className="feed-config-label">关注人物</span><div className="feed-template-people" role="group" aria-label="关注人物">{FEED_PEOPLE.map(person=><button key={person.id} type="button" role="checkbox" aria-label={`关注${person.name}`} aria-checked={people.includes(person.id)} disabled={disabled||(people.length===1&&people.includes(person.id))} onClick={()=>onPeople(people.includes(person.id)?people.filter(id=>id!==person.id):[...people,person.id])}><span className="feed-person-check">{people.includes(person.id)&&<IconCheck size={14}/>}</span><span><strong>{person.name}</strong><small>{person.platform} · {person.handle}</small></span></button>)}</div></>}
  </div>;
}
