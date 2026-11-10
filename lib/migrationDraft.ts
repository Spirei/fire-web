export type MigrationMapping={source_owner:string;account_kinds:Record<string,string>;broker_labels:Record<string,string>;market_accounts:Record<string,string>;order_accounts?:Record<string,string>};
type Scope={users:{id:string}[];accounts:{id:string;owner_id:string;kind:string|null}[];broker_labels:{label:string}[];orders:{id:string;owner_id:string}[]};
export const migrationStorageKey=(kind:string,instance:string,owner:string,preparation:string)=>['fire:migration',kind,instance,owner,preparation].map(encodeURIComponent).join(':');
/** Restore choices only inside the current source scope; never restore credentials or financial amounts. */
export function migrationMapping(value:unknown,scope:Scope):MigrationMapping{
 const input=value&&typeof value==='object'?value as Partial<MigrationMapping>:{};
 const source_owner=scope.users.some(user=>user.id===input.source_owner)?input.source_owner!:scope.users.length===1?scope.users[0].id:'';
 const accounts=new Set(scope.accounts.filter(account=>account.owner_id===source_owner).map(account=>account.id));
 const labels=new Set(scope.broker_labels.map(label=>label.label)),orders=new Set(scope.orders.filter(order=>order.owner_id===source_owner).map(order=>order.id));
 const filter=(raw:unknown,valid:(key:string,value:string)=>boolean)=>Object.fromEntries(raw&&typeof raw==='object'&&!Array.isArray(raw)?Object.entries(raw).filter(([key,value])=>typeof value==='string'&&valid(key,value)):[]) as Record<string,string>;
 const kinds=Object.fromEntries(scope.accounts.filter(account=>accounts.has(account.id)&&['real','simulated'].includes(account.kind??'')).map(account=>[account.id,account.kind!]));
 return {source_owner,account_kinds:{...kinds,...filter(input.account_kinds,(key,value)=>accounts.has(key)&&['real','simulated'].includes(value))},
  broker_labels:filter(input.broker_labels,(key,value)=>labels.has(key)&&accounts.has(value)),
  market_accounts:filter(input.market_accounts,(key,value)=>['US','HK','CN','JP','KR','ASSET'].includes(key)&&accounts.has(value)),
  order_accounts:filter(input.order_accounts,(key,value)=>orders.has(key)&&accounts.has(value))};
}
export function sameMigrationMapping(a:MigrationMapping,b:MigrationMapping){
 const sorted=(value:MigrationMapping)=>[value.source_owner,...(['account_kinds','broker_labels','market_accounts','order_accounts'] as const).map(key=>Object.entries(value[key]??{}).sort(([a],[b])=>a.localeCompare(b)))];
 return JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
}
