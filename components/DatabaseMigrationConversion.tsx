"use client";

import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconLoader2, IconAlertCircle, IconChevronDown, IconShieldLock, IconBuildingBank, IconChartPie, IconArrowsExchange, IconWallet, IconChartHistogram, IconPhoto } from '@tabler/icons-react';
import AppSelect from '@/components/AppSelect';
import { Capsule, CapsuleLink } from '@/components/Capsule';
import { platformRequest as request, PlatformRequestError } from '@/lib/platformRequest';
import { requestAdminProof } from '@/lib/adminProof';
import { useWorkspaceSearchParams, useWorkspaceLocationGuard } from '@/lib/workspacePanel';
import type { WebSession } from '@/lib/workspaceInitial';

type Domain={key:string;label:string;source:number|null;converted:number;state:string;holdings?:number;excluded_trade_projections?:number};
type ConversionTask={id:string;request_id:string;kind:'database.migration.convert';status:string;input?:{source_owner:string;account_kinds:Record<string,string>;broker_labels:Record<string,string>;market_accounts:Record<string,string>;order_accounts?:Record<string,string>};result?:{phase:string;preparation_id?:string;domains?:Domain[];issue_counts?:Record<string,number>;progress?:{phase:string;processed:number;total:number|null};message?:string;portfolio_ready?:boolean;portfolio_issues?:string[];plan_sha256?:string;account_kinds?:Record<string,string>;broker_labels?:Record<string,string>};};
type PortfolioTask={id:string;request_id:string;kind:'database.migration.portfolio';status:string;conversion_id?:string;result?:{phase:string;business_written:boolean|null;counts?:{records:number;holdings:number;accounts:number;groups:number};message?:string;progress?:{processed:number;total:number|null}}};
type HistoryTask={id:string;request_id:string;kind:'database.migration.history'|'database.migration.complete';status:string;conversion_id?:string;result?:{phase:string;conversion_id?:string;business_written:boolean|null;history_imported?:boolean;migration_complete?:boolean;stages?:{personal?:{fire_plans:number;simple_ledgers:number;custom_cards:number;card_holdings:number;feed_posts:number;price_alert_rules:number;source_missing_card_images?:string[]}};completed_domains?:string[];counts?:{orders:number;funds:number;independent_funds:number;recorded_pnl:number};message?:string;progress?:{processed:number;total:number|null}}};
type Context={history_imports?:HistoryTask[];imports:PortfolioTask[];orders:{id:string;owner_id:string;market:string;code:string;name:string;broker:string}[];preparation_id:string;users:{id:string;username:string}[];accounts:{id:string;owner_id:string;name:string;kind:string|null}[];broker_labels:{label:string;rows:number}[];items:ConversionTask[]};
const issueLabels:Record<string,string>={
  account_mapping_conflict:'原账户与市场默认规则冲突',
  original_registered_position_projection_differs:'原成本与新算法结果不同',original_position_prefix_inconsistent:'历史持仓前后不衔接',
  original_fill_causal_order_unproved:'同一时间的交易顺序待核对',original_input_missing:'原始字段缺失',source_current_position_differs_from_original_history:'当前持仓与历史重放不同',
  original_fill_values_not_reconcilable:'成交数值无法对账',unallocated_fund_real_simulated_scope_unknown:'独立资金记录未分类',
  unallocated_nonopening_cash_requires_verified_attribution:'独立资金记录待归属',original_order_real_simulated_identity_unknown:'订单账户待分类',
  actual_fee_authority_unknown:'历史费用缺少独立确认来源',original_unallocated_order_needs_verified_attribution:'订单缺少账户归属',
  original_real_simulated_identity_unknown:'来源账户未分类',no_independent_position_opening:'持仓期初缺少独立依据',
  verified_nonzero_opening_requires_canonical_opening_support:'非零期初待转换核对',original_negative_cash_requires_financing_authority:'负现金余额缺少融资依据',
  connect_actual_cny_settlement_missing:'港股通缺少实际人民币结算额',source_table_coverage_incomplete:'来源字段覆盖待核对',
  legacy_number_cash_projection_requires_explicit_reconciliation:'原现金精度差异待对账',
};
const domainState:Record<string,string>={normalized:'已转换 · 待导入',analyzed:'已核对',needs_confirmation:'待确认',requires_cutover:'待身份切换',retained_not_recalculated:'保留原值 · 待核对',requires_file_verification:'待核对原件',unknown:'来源范围待核对'};
const domainIcons:Record<string,typeof IconCheck>={identity:IconShieldLock,accounts:IconBuildingBank,positions:IconChartPie,orders:IconArrowsExchange,cash:IconWallet,pnl:IconChartHistogram,assets:IconPhoto};
const domainUnits:Record<string,string>={identity:'个账号',accounts:'个账户',positions:'条记录',orders:'笔交易',cash:'笔流水',pnl:'笔卖出与股息',assets:'项素材'};
const issueGroups=[
  {label:'账户归属',keys:['account_mapping_conflict','original_unallocated_order_needs_verified_attribution','original_order_real_simulated_identity_unknown','original_real_simulated_identity_unknown']},
  {label:'交易与盈亏',keys:['original_registered_position_projection_differs','original_position_prefix_inconsistent','original_fill_causal_order_unproved','source_current_position_differs_from_original_history','original_fill_values_not_reconcilable','actual_fee_authority_unknown','no_independent_position_opening','verified_nonzero_opening_requires_canonical_opening_support','connect_actual_cny_settlement_missing']},
  {label:'资金记录',keys:['unallocated_fund_real_simulated_scope_unknown','unallocated_nonopening_cash_requires_verified_attribution','original_negative_cash_requires_financing_authority','legacy_number_cash_projection_requires_explicit_reconciliation']},
];
const running=(task?:ConversionTask|null)=>!!task&&['queued','running','cancel_requested'].includes(task.status);
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export default function DatabaseMigrationConversion({preparationId,ownerId,active}:{preparationId:string;ownerId:string;active:boolean}){
  const params=useWorkspaceSearchParams(),canUseLocation=useWorkspaceLocationGuard();
  const requested=params.get('conversionRequest')||'';
  const [portfolioRequest,setPortfolioRequest]=useState(params.get('portfolioRequest')||''),[portfolioTask,setPortfolioTask]=useState<PortfolioTask|null>(null);
  const [historyRequest,setHistoryRequest]=useState(params.get('historyRequest')||''),[historyTask,setHistoryTask]=useState<HistoryTask|null>(null),[needLogin,setNeedLogin]=useState(false);
  const notified=useRef('');
  const [context,setContext]=useState<Context|null>(null),[task,setTask]=useState<ConversionTask|null>(null);
  const [sourceOwner,setSourceOwner]=useState(''),[kinds,setKinds]=useState<Record<string,string>>({}),[labels,setLabels]=useState<Record<string,string>>({});
  const [markets,setMarkets]=useState<Record<string,string>>({}),[orders,setOrders]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[verify,setVerify]=useState(false),[revision,setRevision]=useState(0);
  const session=useRef<WebSession|null>(null),lifetime=useRef<AbortController|null>(null),pending=useRef(false),unknown=useRef('');
  const writePortfolioUrl=(value:string)=>{if(!canUseLocation())return;const url=new URL(window.location.href);if(value)url.searchParams.set('portfolioRequest',value);else url.searchParams.delete('portfolioRequest');window.history.replaceState(null,'',url);};
  const writeHistoryUrl=(value:string)=>{if(!canUseLocation())return;const url=new URL(window.location.href);if(value)url.searchParams.set('historyRequest',value);else url.searchParams.delete('historyRequest');window.history.replaceState(null,'',url);};
  const writeUrl=(value:string)=>{if(!canUseLocation())return;const url=new URL(window.location.href);if(value)url.searchParams.set('conversionRequest',value);else url.searchParams.delete('conversionRequest');window.history.replaceState(null,'',url);};
  const headers=()=>({'content-type':'application/json','x-csrf-token':session.current?.csrf??''});
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();lifetime.current=controller;let timer:ReturnType<typeof setTimeout>|undefined;let polling=false;
    setContext(null);setTask(null);setError('');session.current=null;
    async function load(){
      try{
        const identity=await request<WebSession>('/api/fire/session',{signal:controller.signal});
        if(identity.user.id!==ownerId||identity.user.role!=='admin')throw Error('管理员身份已变化，请重新登录');
        session.current=identity;
        const value=await request<Context>(`/api/fire/database-migration/preparations/${preparationId}/conversion`,{signal:controller.signal,headers:headers()});
        if(controller.signal.aborted)return;
        if(value.preparation_id!==preparationId)throw Error('转换来源记录不匹配');
        setContext(value);setSourceOwner(value.users.length===1?value.users[0].id:'');
        setKinds(Object.fromEntries(value.accounts.filter(item=>item.kind).map(item=>[item.id,item.kind!])));
        setLabels({});setMarkets({});setOrders({});
        let current=value.items.find(item=>item.request_id===requested)??(!requested?value.items[0]:undefined);
        if(requested&&uuid(requested)&&!current){
          const receipt=await request<ConversionTask>('/api/fire/tasks/receipts/'+requested,{signal:controller.signal,headers:headers()});
          if(receipt.kind!=='database.migration.convert'||receipt.result?.preparation_id!==preparationId)throw Error('转换任务不属于本次准备记录');
          current=receipt;
        }
        if(controller.signal.aborted)return;
        setTask(current??null);const imported=(value.imports??[]).find(item=>portfolioRequest?item.request_id===portfolioRequest:item.conversion_id===current?.id);if(imported){setPortfolioTask(imported);setPortfolioRequest(imported.request_id);}
        const history=(value.history_imports??[]).find(item=>historyRequest?item.request_id===historyRequest:item.conversion_id===current?.id);if(history){setHistoryTask(history);setHistoryRequest(history.request_id);}
        if(current){unknown.current=running(current)?current.request_id:'';if(current.input){setSourceOwner(current.input.source_owner);setKinds(current.input.account_kinds);setLabels(current.input.broker_labels);setMarkets(current.input.market_accounts);setOrders(current.input.order_accounts??{});}if(running(current))void poll(current.request_id);}
      }catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
    }
    async function poll(id:string){
      if(controller.signal.aborted||polling)return;
      if(document.hidden){timer=setTimeout(()=>void poll(id),2500);return;}
      polling=true;
      try{
        const receipt=await request<ConversionTask>('/api/fire/tasks/receipts/'+id,{signal:controller.signal,headers:headers()});
        const detail=await request<ConversionTask>('/api/fire/tasks/'+receipt.id,{signal:controller.signal,headers:headers()});
        if(detail.kind!=='database.migration.convert'||detail.request_id!==id||detail.result?.preparation_id&&detail.result.preparation_id!==preparationId)throw Error('转换回执不匹配');
        if(controller.signal.aborted)return;setTask(before=>({...detail,input:before?.input}));
        if(!running(detail)){unknown.current='';return;}
      }catch(e){if(controller.signal.aborted)return;const failure=e as PlatformRequestError;if(failure.status!==404)setError(failure.message);}
      finally{polling=false;}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(id),2500);
    }
    void load();
    return()=>{controller.abort();clearTimeout(timer);pending.current=false;session.current=null;};
  // A task is selected by its durable URL, never submitted on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,ownerId,preparationId,revision]);

  useEffect(()=>{
    if(!active||!portfolioRequest)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      if(controller.signal.aborted)return;
      if(document.hidden||!session.current){timer=setTimeout(()=>void poll(),2000);return;}
      try{
        const receipt=await request<PortfolioTask>('/api/fire/tasks/receipts/'+portfolioRequest,{signal:controller.signal,headers:headers()});
        const value=await request<PortfolioTask>('/api/fire/tasks/'+receipt.id,{signal:controller.signal,headers:headers()});
        if(value.kind!=='database.migration.portfolio'||value.request_id!==portfolioRequest)throw Error('持仓导入回执不匹配');
        if(controller.signal.aborted)return;setPortfolioTask(value);
        if(value.result?.business_written===true&&notified.current!==portfolioRequest){notified.current=portfolioRequest;window.dispatchEvent(new Event('fire:records-updated'));window.dispatchEvent(new Event('fire:settings-updated'));}
        if(!['queued','running','cancel_requested'].includes(value.status))return;
      }catch(e){if(controller.signal.aborted)return;const failure=e as PlatformRequestError;if(failure.status===401){setNeedLogin(true);return;}if(failure.status!==404)setError(failure.message);}
      timer=setTimeout(()=>void poll(),2000);
    }
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,portfolioRequest,ownerId,preparationId]);
  useEffect(()=>{
    if(!active||!historyRequest)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      if(controller.signal.aborted)return;
      if(document.hidden||!session.current){timer=setTimeout(()=>void poll(),2000);return;}
      try{
        const receipt=await request<HistoryTask>('/api/fire/tasks/receipts/'+historyRequest,{signal:controller.signal,headers:headers()});
        const value=await request<HistoryTask>('/api/fire/tasks/'+receipt.id,{signal:controller.signal,headers:headers()});
        if(!['database.migration.history','database.migration.complete'].includes(value.kind)||value.request_id!==historyRequest||value.result?.conversion_id&&value.result.conversion_id!==task?.id)throw Error('历史导入回执不匹配');
        if(controller.signal.aborted)return;setHistoryTask(value);
        if(value.result?.history_imported&&notified.current!==historyRequest){notified.current=historyRequest;window.dispatchEvent(new Event('fire:records-updated'));}
        if(!['queued','running','cancel_requested'].includes(value.status))return;
      }catch(e){if(controller.signal.aborted)return;const failure=e as PlatformRequestError;if(failure.status===401){setNeedLogin(true);return;}if(failure.status!==404)setError(failure.message);}
      timer=setTimeout(()=>void poll(),2000);
    }
    if(task?.id)void poll();return()=>{controller.abort();clearTimeout(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,historyRequest,ownerId,preparationId,task?.id]);
  async function importHistory(){
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||pending.current||!task?.result?.plan_sha256)return;
    pending.current=true;setBusy(true);setError('');const id=crypto.randomUUID();setHistoryTask(null);setHistoryRequest(id);writeHistoryUrl(id);
    try{const accepted=await request<HistoryTask>('/api/fire/database-migration/conversions/'+task.id+'/complete',{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:id,plan_sha256:task.result.plan_sha256,confirmed_registered_values:true})});if(!signal.aborted)setHistoryTask(accepted);}
    catch(e){if(signal.aborted)return;const failure=e as PlatformRequestError;setError(failure.message);if(failure.reauthentication)setVerify(true);if(failure.status&&failure.status<500){setHistoryRequest('');writeHistoryUrl('');}}
    finally{if(!signal.aborted){pending.current=false;setBusy(false);}}
  }
  async function cancelHistory(){
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||pending.current||!historyRequest)return;
    pending.current=true;setBusy(true);try{const value=await request<HistoryTask>('/api/fire/database-migration/completion/cancel',{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:historyRequest})});if(!signal.aborted)setHistoryTask(value);}catch(e){if(!signal.aborted)setError((e as Error).message);}finally{pending.current=false;setBusy(false);}
  }
  async function importPortfolio(){
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||pending.current||!task?.result?.plan_sha256)return;
    pending.current=true;setBusy(true);setError('');setPortfolioTask(null);const id=crypto.randomUUID();setPortfolioRequest(id);writePortfolioUrl(id);
    try{const accepted=await request<PortfolioTask>('/api/fire/database-migration/conversions/'+task.id+'/portfolio',{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:id,plan_sha256:task.result.plan_sha256,confirmed_registered_values:true})});if(!signal.aborted)setPortfolioTask(accepted);}
    catch(e){if(signal.aborted)return;const failure=e as PlatformRequestError;setError(failure.message);if(failure.reauthentication)setVerify(true);if(failure.status&&failure.status<500){setPortfolioRequest('');writePortfolioUrl('');}}
    finally{if(!signal.aborted){pending.current=false;setBusy(false);}}
  }
  async function cancelPortfolio(){
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||pending.current||!portfolioRequest)return;
    pending.current=true;setBusy(true);try{const value=await request<PortfolioTask>('/api/fire/database-migration/portfolio/cancel',{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:portfolioRequest})});if(!signal.aborted)setPortfolioTask(value);}catch(e){if(!signal.aborted)setError((e as Error).message);}finally{pending.current=false;setBusy(false);}
  }
  async function start(){
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||pending.current||!sourceOwner)return;
    pending.current=true;setBusy(true);setError('');const id=crypto.randomUUID();
    unknown.current=id;writeUrl(id);
    try{
      const accepted=await request<ConversionTask>(`/api/fire/database-migration/preparations/${preparationId}/conversion`,{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:id,source_owner:sourceOwner,timezone:'Asia/Shanghai',account_kinds:kinds,broker_labels:labels,market_accounts:markets,order_accounts:orders})});
      if(signal.aborted)return;
      if(accepted.kind!=='database.migration.convert'||accepted.request_id!==id)throw Error('转换请求结果尚未核对');
      setTask({...accepted,input:{source_owner:sourceOwner,account_kinds:kinds,broker_labels:labels,market_accounts:markets,order_accounts:orders}});setRevision(value=>value+1);
    }catch(e){
      if(signal.aborted)return;const failure=e as PlatformRequestError;setError(failure.message);if(failure.reauthentication)setVerify(true);
      if(failure.status&&failure.status<500){unknown.current='';writeUrl('');}else setRevision(value=>value+1);
    }finally{if(!signal.aborted){pending.current=false;setBusy(false);}}
  }
  async function cancel(){
    const signal=lifetime.current?.signal,id=unknown.current||task?.request_id;if(!signal||signal.aborted||pending.current||!id)return;
    pending.current=true;setBusy(true);setError('');
    try{const result=await request<ConversionTask>('/api/fire/database-migration/conversions/cancel',{method:'POST',signal,headers:headers(),body:JSON.stringify({request_id:id})});if(!signal.aborted){setTask(result);unknown.current='';if(result.status==='cancelled')writeUrl('');}}
    catch(e){if(!signal.aborted)setError((e as Error).message);}finally{pending.current=false;setBusy(false);}
  }
  async function authorize(){
    if(pending.current)return;pending.current=true;setBusy(true);
    try{const proof=await requestAdminProof();if(!proof)return;await request('/api/fire/connections/reauthenticate',{method:'POST',headers:headers(),body:JSON.stringify(proof)});setVerify(false);setError('');}
    catch(e){setError((e as Error).message);}finally{pending.current=false;setBusy(false);}
  }
  const accounts=context?.accounts.filter(item=>item.owner_id===sourceOwner)??[],options=accounts.map(item=>({value:item.id,label:item.name}));
  const moving=running(task),result=task?.result;
  const importing=!!portfolioRequest&&(!portfolioTask||['queued','running','cancel_requested'].includes(portfolioTask.status));
  const imported=portfolioTask?.result?.business_written===true;
  const historyImporting=!!historyRequest&&(!historyTask||['queued','running','cancel_requested'].includes(historyTask.status));
  const historyImported=historyTask?.result?.history_imported===true;
  const allImported=historyTask?.result?.migration_complete===true;
  const completedKeys=Array.from(new Set([...(imported?['accounts','positions']:[]),...(historyTask?.result?.completed_domains??[]),...(historyImported?['orders','cash','pnl']:[]),...(allImported?['identity','assets']:[])]));
  const completedDomains=result?.domains?.filter(domain=>completedKeys.includes(domain.key)).length??0;
  const issues=Object.entries(result?.issue_counts??{}).filter(([,count])=>count>0);
  const groupedIssues=[...issueGroups.map(group=>({...group,items:issues.filter(([key])=>group.keys.includes(key))})),
    {label:'来源字段',items:issues.filter(([key])=>!issueGroups.some(group=>group.keys.includes(key)))}].filter(group=>group.items.length);
  const unchanged=task?.status==='succeeded'&&task.input&&JSON.stringify([sourceOwner,kinds,labels,markets,orders])===JSON.stringify([task.input.source_owner,task.input.account_kinds,task.input.broker_labels,task.input.market_accounts,task.input.order_accounts??{}]);
  return <div className="migration-conversion mt-6">
    <div className="migration-conversion-heading"><div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold text-ink">数据转换</h2>{!!result?.domains?.length&&<span className="migration-conversion-count">已导入 {completedDomains} / {result.domains.length} 类</span>}</div><Capsule busy={busy||moving} disabled={!context||!sourceOwner||!!unknown.current&& !task||verify||!!unchanged||importing||historyImporting||needLogin} onClick={()=>void start()}>{moving?'转换中':'转换并校验'}</Capsule></div>
    {(moving||!!unknown.current&&!task)&&<div className="mt-4 flex justify-end"><Capsule variant="secondary" disabled={busy||task?.status==='cancel_requested'} onClick={()=>void cancel()}>{task?.status==='cancel_requested'?'取消中':'取消转换'}</Capsule></div>}
    {error&&<p className="mt-4 text-sm text-red-500" role="alert">{error}</p>}
    {verify&&<div className="mt-4"><Capsule variant="secondary" busy={busy} onClick={()=>void authorize()}>验证身份</Capsule></div>}
    {context&&!moving&&<details className="mt-5" open={!result?.domains}><summary className="cursor-pointer text-sm text-ink-2">账户映射</summary>
      {context.users.length>1&&<label className="mt-4 grid gap-2 text-sm text-ink-3">来源账号<AppSelect ariaLabel="来源账号" value={sourceOwner} options={context.users.map(item=>({value:item.id,label:item.username}))} onChange={value=>{setSourceOwner(value);setLabels({});setMarkets({});setOrders({});}}/></label>}
      <div className="migration-conversion-mappings mt-4">{accounts.map(item=><label key={item.id} className="grid gap-2 text-sm text-ink-3">{item.name}<AppSelect ariaLabel={item.name+'分类'} value={kinds[item.id]??''} options={[{value:'',label:'待确认'},{value:'real',label:'真实'},{value:'simulated',label:'模拟'}]} onChange={value=>setKinds(before=>{const next={...before};if(value)next[item.id]=value;else delete next[item.id];return next;})}/></label>)}</div>
      <div className="migration-conversion-mappings mt-4">{context.broker_labels.map(item=><label key={item.label} className="grid gap-2 text-sm text-ink-3">{item.label} · {item.rows} 笔<AppSelect ariaLabel={item.label+'归属'} value={labels[item.label]??''} options={[{value:'',label:'沿用原记录'},...options]} onChange={value=>setLabels(before=>{const next={...before};if(value)next[item.label]=value;else delete next[item.label];return next;})}/></label>)}</div>
      <div className="migration-conversion-mappings mt-4">{[['US','美股'],['HK','港股默认账户'],['CN','A 股']].map(([key,title])=><label key={key} className="grid gap-2 text-sm text-ink-3">{title}<AppSelect ariaLabel={title+'账户归属'} value={markets[key]??''} options={[{value:'',label:'沿用原记录'},...options]} onChange={value=>setMarkets(before=>{const next={...before};if(value)next[key]=value;else delete next[key];return next;})}/></label>)}</div>
      <div className="migration-conversion-mappings mt-4">{(context.orders??[]).filter(item=>item.owner_id===sourceOwner&&(orders[item.id]||labels[item.broker]&&markets[item.market]&&labels[item.broker]!==markets[item.market])).map(item=><label key={item.id} className="grid gap-2 text-sm text-ink-3">{item.code} · {item.name}<AppSelect ariaLabel={item.id+'逐笔归属'} value={orders[item.id]??''} options={[{value:'',label:'逐笔待确认'},...options]} onChange={value=>setOrders(before=>{const next={...before};if(value)next[item.id]=value;else delete next[item.id];return next;})}/></label>)}</div>
    </details>}
    {moving&&<div className="mt-5" role="status"><div className="flex items-center gap-2 text-sm text-ink-2"><IconLoader2 size={18} className="animate-spin motion-reduce:animate-none"/>{result?.phase==='conversion_financial'?'转换交易与资金':result?.phase==='conversion_domains'?'核对业务数据':'核对原归档'}{result?.progress?.total!=null&&<span className="ml-auto tabular-nums">{result.progress.processed} / {result.progress.total}</span>}</div>{result?.progress?.total!=null&&result.progress.total>0&&<div className="migration-stage-progress" role="progressbar" aria-label="数据转换进度" aria-valuemin={0} aria-valuemax={result.progress.total} aria-valuenow={result.progress.processed}><span style={{width:`${Math.min(100,result.progress.processed/result.progress.total*100)}%`}}/></div>}</div>}
    {result?.domains&&<><div className="migration-conversion-domains mt-5">{result.domains.map(domain=>{
      const done=completedKeys.includes(domain.key),DomainIcon=domainIcons[domain.key]??IconAlertCircle;
      return <div key={domain.key} className="migration-domain" data-complete={done}>
        <span className="migration-domain-icon"><DomainIcon size={20} stroke={1.7}/></span>
        <div className="migration-domain-content"><div className="migration-domain-title"><strong>{domain.label}</strong><span className="migration-domain-status">{done&&<IconCheck size={13}/>} {done?['orders','cash','pnl'].includes(domain.key)?'原值已迁入':'已导入':domainState[domain.state]??'待核对'}</span></div>
          <p className="migration-domain-total"><b>{domain.source??'—'}</b><span>{domainUnits[domain.key]??'条来源记录'}</span>{domain.holdings!==undefined&&<span>· {domain.holdings} 项持仓</span>}</p>
          {domain.excluded_trade_projections? <p className="migration-domain-note">关联 {domain.excluded_trade_projections} 笔 · 独立 {domain.converted} 笔</p>:domain.key==='pnl'?<p className="migration-domain-note">{domain.converted} 笔有原始盈亏</p>:null}
        </div>
      </div>;
    })}</div>
      {!!issues.length&&<details className="migration-review"><summary><span className="migration-review-heading"><IconAlertCircle size={17}/><strong>待核对</strong><span>{issues.length} 类差异</span></span><IconChevronDown size={16}/></summary><div className="migration-review-groups">{groupedIssues.map(group=><div key={group.label}><h3>{group.label}</h3><dl className="migration-conversion-issues">{group.items.map(([key,count])=><div key={key}><dt>{issueLabels[key]??'来源结构或依据待核对'}</dt><dd className="tabular-nums">{count}</dd></div>)}</dl></div>)}</div></details>}
      {!imported&&<div className="mt-4 flex flex-wrap items-center justify-end gap-3">{importing&&<Capsule variant="secondary" disabled={busy||portfolioTask?.status==='cancel_requested'} onClick={()=>void cancelPortfolio()}>取消导入</Capsule>}<Capsule disabled={busy||moving||importing||!result.portfolio_ready||verify} busy={importing} onClick={()=>void importPortfolio()}>{importing?'正在导入持仓与自选':'导入持仓与自选'}</Capsule></div>}
      {imported&&!allImported&&!needLogin&&<div className="mt-4 flex flex-wrap items-center justify-end gap-3">{historyImporting&&<Capsule variant="secondary" disabled={busy||historyTask?.status==='cancel_requested'} onClick={()=>void cancelHistory()}>停止剩余步骤</Capsule>}<Capsule disabled={busy||moving||historyImporting||verify} busy={historyImporting} onClick={()=>void importHistory()}>{historyImporting?'正在迁移':historyTask?.status==='failed'?'继续未完成步骤':'完成剩余迁移'}</Capsule></div>}
      {historyImporting&&!needLogin&&<div className="mt-4 flex items-center gap-2 text-sm text-ink-2" role="status"><IconLoader2 size={17} className="animate-spin motion-reduce:animate-none"/>{{completion_backup:'备份新库',history_import:'迁入交易与资金',completion_assets:'核对素材原件',completion_personal:'迁入个人数据',completion_identity:'切换旧账号身份'}[historyTask?.result?.phase??'']??'准备迁移'}{historyTask?.result?.progress?.total!=null&&<span className="ml-auto tabular-nums">{historyTask.result.progress.processed} / {historyTask.result.progress.total}</span>}</div>}
      {historyImporting&&historyTask?.result?.progress?.total!=null&&historyTask.result.progress.total>0&&<div className="migration-stage-progress" role="progressbar" aria-label="当前迁移步骤进度" aria-valuemin={0} aria-valuemax={historyTask.result.progress.total} aria-valuenow={historyTask.result.progress.processed}><span style={{width:`${Math.min(100,historyTask.result.progress.processed/historyTask.result.progress.total*100)}%`}}/></div>}
      {allImported&&historyTask?.result?.stages?.personal&&<div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-3">{Object.entries({FIRE规划:historyTask.result.stages.personal.fire_plans,记账:historyTask.result.stages.personal.simple_ledgers,自定义卡片:historyTask.result.stages.personal.custom_cards,持有卡片:historyTask.result.stages.personal.card_holdings,动态:historyTask.result.stages.personal.feed_posts,提醒:historyTask.result.stages.personal.price_alert_rules}).map(([label,count])=><span key={label}>{label} · {count}</span>)}</div>}
      {!!historyTask?.result?.stages?.personal?.source_missing_card_images?.length&&<p className="mt-3 text-sm text-ink-3">{historyTask.result.stages.personal.source_missing_card_images.length} 张旧自定义卡片缺少图片原件</p>}
      {needLogin&&<div className="mt-4 flex justify-end"><CapsuleLink href={"/login?next="+encodeURIComponent(window.location.pathname+window.location.search)}>使用旧账号重新登录</CapsuleLink></div>}
      {historyTask?.status==='failed'&&historyTask.result?.message&&<p className="mt-3 text-sm text-red-500" role="alert">{historyTask.result.message}</p>}
      {importing&&portfolioTask?.result?.progress?.total!=null&&<p className="mt-3 text-right text-sm text-ink-3 tabular-nums">{portfolioTask.result.progress.processed} / {portfolioTask.result.progress.total}</p>}
      {portfolioTask?.status==='failed'&&portfolioTask.result?.message&&<p className="mt-3 text-sm text-red-500" role="alert">{portfolioTask.result.message}</p>}
    </>}
    {task?.status==='failed'&&result?.message&&<p className="mt-4 text-sm text-red-500" role="alert">{result.message}</p>}
  </div>;
}
