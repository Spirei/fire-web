"use client";
import { IconArchive, IconArrowRight } from "@tabler/icons-react";
export type RetiredApiOperation = {method:string;path:string;reason:string;replacement:string};
export function groupRetirements(items:RetiredApiOperation[]) {
  const groups=new Map<string,{reason:string;replacement:string;count:number;paths:Map<string,Set<string>>}>();
  for(const item of items){
    const key=JSON.stringify([item.reason,item.replacement]);
    let group=groups.get(key);
    if(!group){group={reason:item.reason,replacement:item.replacement,count:0,paths:new Map()};groups.set(key,group);}
    group.count++;
    const methods=group.paths.get(item.path)||new Set<string>();methods.add(item.method);group.paths.set(item.path,methods);
  }
  return [...groups.values()].map(group=>({...group,paths:[...group.paths].map(([path,methods])=>({path,methods:[...methods]}))}));
}
export default function ApiRetirements({items}:{items:RetiredApiOperation[]}) {
  return <div className="api-retirements">{groupRetirements(items).map((group,index)=><section key={index} className="api-retirement-group"><header><IconArchive size={18} stroke={1.6} aria-hidden="true"/><p>{group.reason}</p><small>{group.count} 个接口</small></header><div className="api-retirement-body"><div className="api-retirement-paths">{group.paths.map(item=><div key={item.path}><span className="api-retirement-methods">{item.methods.map(method=><code className="api-method" key={method}>{method}</code>)}</span><code>{item.path}</code></div>)}</div><div className="api-retirement-replacement"><span><IconArrowRight size={15} aria-hidden="true"/>替代能力</span><code>{group.replacement}</code></div></div></section>)}</div>;
}
