import type { WorkspaceInitial, WebSession, MaterialListing } from './workspaceInitial';
/** Request-local reads only. No cross-account cache and no speculative financial requests. */
export async function workspaceBootstrap(tab:string,query:URLSearchParams,identity:WebSession,read:<T>(path:string)=>Promise<T>):Promise<WorkspaceInitial>{
 const initial:WorkspaceInitial={};
 if(tab==='backup-recovery'&&identity.user.role==='admin'){
  const [connections,backups,preparations]=await Promise.all([read<NonNullable<WorkspaceInitial['backupRecovery']>['connections']>('/api/fire/database-migration/connections'),read<NonNullable<WorkspaceInitial['backupRecovery']>['backups']>('/api/fire/backups'),read<{items:import('./databaseMigration').MigrationPreparationTask[]}>('/api/fire/database-migration/preparations')]);
  const requested=query.get('migrationRequest')||'';
  let preparation=requested?preparations.items.find(item=>item.request_id===requested):preparations.items[0];
  if(requested&&!preparation&&/^[a-f0-9-]{36}$/i.test(requested)){
   try{const receipt=await read<import('./databaseMigration').MigrationPreparationTask>('/api/fire/tasks/receipts/'+requested);if(receipt.kind==='database.migration.prepare')preparation=receipt;}catch{}
  }
  initial.backupRecovery={identity,connections,backups,preparations:preparations.items,preparation};
 }else if(tab==='library'&&identity.user.role==='admin'){
  const type=['market','stock','crypto','metal','flag','broker','group','card','icon'].includes(query.get('tab')||'')?query.get('tab')!:'market';
  const market=query.get('market')||'ALL',q=(query.get('q')||'').slice(0,200),page=Math.max(1,Number(query.get('page'))||1),removed=type!=='group'&&query.get('removed')==='1';
  let data:MaterialListing;
  if(type==='group'){
   const result=await read<{data:{groups:{id:string;name:string;icon:string;kind:string}[]}}>('/api/v1/watch-groups');
   const groups=result.data.groups.filter(g=>g.kind==='custom'&&(!q||g.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()))),safe=Math.min(page,Math.max(1,Math.ceil(groups.length/10)));
   data={assets:groups.slice((safe-1)*10,safe*10).map(g=>({id:g.id,type:'group',market:'GROUP',code:g.id,name:g.name,url:g.icon,brokerMarkets:[]})),total:groups.length,page:safe,revision:'owner-groups',marketCounts:{}};
  }else data=await read('/api/assets/catalog?'+new URLSearchParams({type,market,q,page:String(page),removed:removed?'1':'0'}));
  initial.material={key:`${identity.user.id}|${type}|${market}|${q}|${page}|${removed}`,data};
 }else if(tab==='cards')initial.cards=await read('/api/cards');
 else if(tab==='watchlist'){const value=await read<{data:{groups:NonNullable<WorkspaceInitial['watchGroups']>}}>('/api/v1/watch-groups');initial.watchGroups=value.data.groups;}
 else if(tab==='activities')initial.logs=await read('/api/activities');
 else if(tab==='trading')initial.feed=await read('/api/feed?'+new URLSearchParams({group:query.get('feedGroup')||'default',author:query.get('feedPerson')||'',limit:'10'}));
 else if(tab==='celebs')initial.celebs=await read('/api/celebs');
 else if(tab==='users'&&identity.user.role==='admin')initial.users=await read('/api/users');
 else if(tab==='quote-pool'){
  type Snapshot=NonNullable<WorkspaceInitial['quotePool']>['mine'];
  const [mine,shared]=await Promise.all([read<{data:Snapshot}>('/api/quote-pool?scope=mine'),identity.user.role==='admin'?read<{data:Snapshot}>('/api/quote-pool?scope=shared'):Promise.resolve(null)]);
  initial.quotePool={mine:mine.data,...(shared?{shared:shared.data}:{})};
 }else if(tab==='settings'&&query.get('sub')==='profile-home'){
  const [profile,activity]=await Promise.all([read<Omit<NonNullable<WorkspaceInitial['personal']>,'activity'>>('/api/auth/personal-home'),read<NonNullable<WorkspaceInitial['personal']>['activity']>('/api/auth/personal-activity')]);
  initial.personal={...profile,activity};
 }else if(['system-overview','background-tasks','api-migration'].includes(tab)&&identity.user.role==='admin'){
  const mode=tab==='system-overview'?'overview':tab==='background-tasks'?'tasks':'migration';
  const filter=['queued','running','succeeded','failed','cancelled','cancel_requested'].includes(query.get('status')||'')?query.get('status')!:'';
  initial.system={mode,filter,identity};
  if(mode==='migration')initial.system.directory=await read('/api/fire/system/api-migration');
  else{
   const [overview,tasks]=await Promise.all([read<NonNullable<WorkspaceInitial['system']>['overview']>('/api/fire/system/overview'),read<NonNullable<WorkspaceInitial['system']>['tasks']>('/api/fire/tasks?limit=25'+(mode==='tasks'&&filter?'&status='+filter:''))]);
   Object.assign(initial.system,{overview,tasks});
  }
 }
 return initial;
}
