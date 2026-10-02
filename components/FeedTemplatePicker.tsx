"use client";

import { IconCamera, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { FEED_PEOPLE } from "@/lib/feedPeopleConfig";
import type { FeedMode, FeedPerson, FeedPersonId } from "@/lib/feedTypes";
import SafeAssetImage from "./SafeAssetImage";
import FeedPersonBadge from "./FeedPersonBadge";

export default function FeedTemplatePicker({mode,people,profiles=FEED_PEOPLE,onMode,onPeople,onAvatarFile,uploadingAvatar,disabled=false}:{mode:FeedMode;people:FeedPersonId[];profiles?:FeedPerson[];onMode:(mode:FeedMode)=>void;onPeople:(people:FeedPersonId[])=>void;onAvatarFile?:(id:FeedPersonId,file:File)=>void;uploadingAvatar?:FeedPersonId|null;disabled?:boolean}) {
  return <div className="feed-template-picker">
    <span className="feed-config-label">动态模板</span>
    <div className="feed-template-options" role="group" aria-label="动态模板">{([{id:"news",name:"新闻动态",note:"按指示搜集新闻、提炼重点"},{id:"people",name:"名人原帖",note:"直接追踪本人发言，保留原文和配图"}] as const).map(template=><button key={template.id} type="button" data-capsule="off" aria-pressed={mode===template.id} disabled={disabled} onClick={()=>onMode(template.id)}><strong>{template.name}</strong><small>{template.note}</small></button>)}</div>
    {mode==="people"&&<><span className="feed-config-label">关注人物</span><div className="feed-template-people" role="group" aria-label="关注人物">{profiles.map(person=>{
      const avatar=<SafeAssetImage src={person.avatar} alt={person.name} className="feed-person-avatar" fallback={<span className="feed-person-avatar feed-person-avatar-fallback">{person.name.slice(0,1)}</span>}/>;
      return <div className="feed-template-person" key={person.id}>
        {onAvatarFile?<label className={`feed-template-avatar-edit ${disabled?"is-disabled":""}`} title="修改头像" data-uploading={uploadingAvatar===person.id||undefined}>{avatar}<span className="feed-avatar-edit-mark" aria-hidden="true">{uploadingAvatar===person.id?<IconLoader2 size={16} className="animate-spin"/>:<IconCamera size={16} stroke={1.9}/>}</span><input type="file" accept="image/jpeg,image/png,image/gif,image/webp" aria-label={`修改${person.name}头像`} disabled={disabled||!!uploadingAvatar} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";if(file)onAvatarFile(person.id,file);}}/></label>:avatar}
        <button type="button" data-capsule="off" role="checkbox" aria-label={`关注${person.name}`} aria-checked={people.includes(person.id)} disabled={disabled||(people.length===1&&people.includes(person.id))} onClick={()=>onPeople(people.includes(person.id)?people.filter(id=>id!==person.id):[...people,person.id])}><span className="feed-template-person-info"><strong className="feed-person-name">{person.name}<FeedPersonBadge personId={person.id}/></strong><small>{person.platform} · {person.handle}</small></span><span className="feed-person-check">{people.includes(person.id)&&<IconCheck size={14}/>}</span></button>
      </div>;
    })}</div></>}
  </div>;
}
