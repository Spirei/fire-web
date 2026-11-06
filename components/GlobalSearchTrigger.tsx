"use client";
import { IconSearch } from "@tabler/icons-react";
import { IconButton } from "./Capsule";
export default function GlobalSearchTrigger() {
  return <IconButton label="搜索功能" onClick={() => window.dispatchEvent(new Event("fire:global-search-open"))}><IconSearch size={20} stroke={1.6}/></IconButton>;
}
