"use client";
import { useEffect, useState } from "react";
import AppSelect from "@/components/AppSelect";
export type ApiOperation = {method:string;path:string;status:"connected"|"pending"|"presentation";category?:string;summary?:string;description?:string;parameters?:unknown[];requestBody?:unknown;responses?:Record<string,unknown>};
type Schemas = Record<string, unknown>;
export const apiCategory=(item:ApiOperation)=>item.category||'其他接口';
export function expandSchema(value:unknown,schemas:Schemas,seen:string[]=[],depth=0):unknown {
 if(depth>6)return value;
 if(Array.isArray(value))return value.map(item=>expandSchema(item,schemas,seen,depth));
 if(value&&typeof value==='object'){
  const object=value as Record<string,unknown>,reference=object.$ref;
  if(typeof reference==='string'&&reference.startsWith('#/components/schemas/')){
   const name=reference.split('/').at(-1)!;
   if(!seen.includes(name)&&schemas[name])return expandSchema(schemas[name],schemas,[...seen,name],depth+1);
  }
  return Object.fromEntries(Object.entries(object).map(([key,item])=>[key,expandSchema(item,schemas,seen,depth)]));
 }
 return value;
}
function Operation({item,schemas}:{item:ApiOperation;schemas:Schemas}){
 const [open,setOpen]=useState(false);
 const sections:[string,unknown][]=[['请求参数',item.parameters?.length?item.parameters:null],['请求正文',item.requestBody],['响应结构',Object.keys(item.responses||{}).length?item.responses:null]];
 return <details className="api-operation" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><code>{item.method}</code><code>{item.path}</code><span>{item.summary||''}</span></summary>{open&&<div className="api-operation-detail">{item.description&&<p>{item.description}</p>}<dl><dt>接口状态</dt><dd>{item.status==='pending'?'待接入':'已登记'}</dd></dl>{sections.map(([label,value])=>value?<details key={label}><summary>{label}</summary><pre>{JSON.stringify(expandSchema(value,schemas),null,2)}</pre></details>:null)}</div>}</details>;
}
function Category({name,items,expanded,schemas}:{name:string;items:ApiOperation[];expanded:boolean;schemas:Schemas}){
 const [open,setOpen]=useState(expanded);
 useEffect(()=>setOpen(expanded),[expanded]);
 return <details className="api-category" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><strong>{name}</strong><span>{items.length} 个接口</span></summary>{open&&<div>{items.map(item=><Operation key={item.method+item.path} item={item} schemas={schemas}/>)}</div>}</details>;
}
export default function ApiCatalogue({items,category,onCategory,schemas={}}:{items:ApiOperation[];category:string;onCategory:(value:string)=>void;schemas?:Schemas}){
 const names=[...new Set(items.map(apiCategory))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 const groups=names.filter(name=>!category||name===category);
 return <div className="api-catalogue"><AppSelect ariaLabel="接口分类" value={category} onChange={onCategory} options={[{value:'',label:'全部分类'},...names.map(value=>({value,label:value}))]}/>{groups.map(name=><Category key={name} name={name} items={items.filter(item=>apiCategory(item)===name)} expanded={!!category||names.length<3} schemas={schemas}/>)}{!groups.length&&<p>没有匹配的接口</p>}</div>;
}
