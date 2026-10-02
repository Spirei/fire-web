type WorkspaceRoute = { key:string; url?:string };
export type WorkspaceVisit = "tab"|"link"|"history";

/** Match the longest owning route; a detail URL belongs to the same retained page. */
export function workspaceForPath(path:string,tabs:readonly WorkspaceRoute[]) {
  if(path==="/asset-pnl-analysis")return "pnl";
  return [...tabs].sort((a,b)=>(b.url||`/${b.key}`).length-(a.url||`/${a.key}`).length)
    .find(tab=>{const base=tab.url||`/${tab.key}`;return path===base||path.startsWith(base+"/");})?.key;
}

/** Explicit settings entries open their requested screen. History retains every page instance. */
export function workspaceDestination(key:string,tabs:readonly WorkspaceRoute[],memory:Map<string,string>,visit:WorkspaceVisit,url?:string,sub?:string|null) {
  const tab=tabs.find(tab=>tab.key===key);
  if(!tab&&key!=="pnl")return null;
  const base=key==="pnl"?"/asset-pnl-analysis":tab?.url||`/${key}`;
  const destination=visit!=="tab"&&url?url:key==="settings"?base+(sub?`?sub=${encodeURIComponent(sub)}`:""):memory.get(key)||base;
  return {url:destination,reset:key==="settings"&&visit!=="history",push:visit!=="history"};
}
