"use client";
import { IconRefresh } from "@tabler/icons-react";
import { IconButton } from "@/components/Capsule";

export default function RefreshButton({onClick,title="刷新",className="",busy=false,disabled=false}:{onClick:()=>void;title?:string;className?:string;busy?:boolean;disabled?:boolean}) {
  return <IconButton label={title} size="sm" framed busy={busy} disabled={disabled} onClick={onClick} className={className}><IconRefresh/></IconButton>;
}
