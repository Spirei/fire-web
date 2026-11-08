"use client";
import { useEffect, useState, type ReactNode } from "react";
import AppSelect from "@/components/AppSelect";
import { IconChevronRight } from "@tabler/icons-react";
export type ApiOperation = {method:string;path:string;status:"connected"|"pending"|"presentation";category?:string;subcategory?:string;categoryOrder?:number;categoryNumber?:number;subcategoryOrder?:number;categoryFeatureIds?:string[];featureIds?:string[];summary?:string;description?:string;parameters?:unknown[];requestBody?:unknown;responses?:Record<string,unknown>};
type Schemas = Record<string, unknown>;
export const apiStatusLabel=(status:ApiOperation["status"])=>({connected:"已匹配后端",pending:"未匹配后端",presentation:"网页端接口"})[status];
export function apiDisplayNumber(value:string|number|undefined) {
 if(value===undefined||value==='')return '';
 const [major,...minor]=String(value).split('.');
 return 'F'+major.padStart(2,'0')+(minor.length?'.'+minor.join('.'):'');
}
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
 return <details className="api-operation" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><code className="api-method" data-method={item.method}>{item.method}</code><code className="api-path">{item.path}</code><span className="api-summary">{item.summary||''}</span><IconChevronRight className="api-chevron" size={16} aria-hidden="true"/></summary>{open&&<div className="api-operation-detail">{item.description&&<p>{item.description}</p>}<dl><dt>入口匹配</dt><dd title="仅核对请求方法和路径，不代表调用成功">{apiStatusLabel(item.status)}</dd>{!!item.featureIds?.length&&<><dt>原 Alcor API 编号</dt><dd>{item.featureIds.join(" · ")}</dd></>}</dl>{sections.map(([label,value])=>value?<details key={label}><summary>{label}</summary><pre>{JSON.stringify(expandSchema(value,schemas),null,2)}</pre></details>:null)}</div>}</details>;
}
function Subcategory({name,items,expanded,schemas}:{name:string;items:ApiOperation[];expanded:boolean;schemas:Schemas}) {
 const [open,setOpen]=useState(expanded);
 useEffect(()=>setOpen(expanded),[expanded]);
 return <details className="api-subcategory" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><strong>{name}</strong><small>{items.length}</small><IconChevronRight className="api-chevron" size={15} aria-hidden="true"/></summary>{open&&<div>{items.map(item=><Operation key={item.method+item.path} item={item} schemas={schemas}/>)}</div>}</details>;
}
function Category({name,items,expanded,schemas}:{name:string;items:ApiOperation[];expanded:boolean;schemas:Schemas}){
 const [open,setOpen]=useState(expanded);
 const number=items[0]?.categoryNumber ?? (items[0]?.categoryOrder ?? 0)+1;
 const subgroups=[...new Set(items.map(item=>item.subcategory||name))].sort((a,b)=>{
   const no=(value:string)=>items.find(item=>(item.subcategory||name)===value)?.subcategoryOrder??999;
   return no(a)-no(b)||a.localeCompare(b,'zh-CN');
 });
 useEffect(()=>setOpen(expanded),[expanded]);
 return <details className="api-category" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><span className="api-category-number" title="接口目录编号">{apiDisplayNumber(number)}</span><strong>{name}</strong><span className="api-category-count">{items.length}<small>接口</small></span><IconChevronRight className="api-chevron" size={17} aria-hidden="true"/></summary>{open&&<div>{subgroups.map(sub=><Subcategory key={sub} name={sub} items={items.filter(item=>(item.subcategory||name)===sub)} expanded={expanded&&subgroups.length===1} schemas={schemas}/>)}</div>}</details>;
}
export default function ApiCatalogue({items,category,onCategory,schemas={},filters}:{items:ApiOperation[];category:string;onCategory:(value:string)=>void;schemas?:Schemas;filters?:ReactNode}){
 const names=[...new Set(items.map(apiCategory))].sort((a,b)=>(items.find(item=>apiCategory(item)===a)?.categoryOrder??999)-(items.find(item=>apiCategory(item)===b)?.categoryOrder??999)||a.localeCompare(b,'zh-CN'));
 const effectiveCategory=names.includes(category)?category:items.find(item=>item.subcategory===category)?.category||category;
 const legacySubcategory=category&&!names.includes(category)&&items.some(item=>item.subcategory===category)?category:"";
 const scoped=legacySubcategory?items.filter(item=>item.subcategory===legacySubcategory):items;
 const groups=names.filter(name=>!effectiveCategory||name===effectiveCategory);
 const filtered=scoped.filter(item=>groups.includes(apiCategory(item)));
 return <div className="api-catalogue"><div className="api-catalogue-tools">{filters}<AppSelect className="api-category-select" ariaLabel="接口分类" value={effectiveCategory} onChange={onCategory} options={[{value:'',label:'全部分类'},...names.map(value=>({value,label:value}))]}/></div><div className="api-catalogue-caption"><span>{groups.length} 个分类 · {filtered.length.toLocaleString("zh-CN")} 个接口</span></div>{groups.map(name=><Category key={name} name={name} items={filtered.filter(item=>apiCategory(item)===name)} expanded={!!effectiveCategory||names.length<3} schemas={schemas}/>)}{!groups.length&&<p>没有匹配的接口</p>}</div>;
}
