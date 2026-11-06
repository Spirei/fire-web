// Execute the original route bodies; only framework/auth/storage boundaries are isolated.
const fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
const root=process.env.ALCOR_FIRE_LEGACY_ROOT;if(!root)throw Error('Explicit readonly source required');
const input=JSON.parse(fs.readFileSync(0,'utf8'));let stored=null;
const response=(data,options={})=>new Response(JSON.stringify(data),{status:options.status||200,headers:options.headers});
const historyCode=transformSync(fs.readFileSync(path.join(root,'lib/fireAssetHistory.ts'),'utf8'),{loader:'ts',format:'cjs'}).code;
const hm={exports:{}};new Function('module','exports',historyCode)(hm,hm.exports);
const dependencies={
 'next/server':{NextResponse:{json:response}},
 '@/lib/auth':{getAuthUser:()=>({id:'synthetic-fire-owner'})},
 '@/lib/requestBody':{readJsonBody:r=>r.json()},
 '@/lib/rateLimit':{rateLimit:()=>true},
 '@/lib/fireAssetHistory':hm.exports,
 '@/lib/fireStore':{getUserFire:()=>stored,setUserFire:(owner,fire)=>{stored={...fire,assetHistory:stored?.assetHistory||[]};return stored.assetHistory;}},
 '@/lib/appApiV2':{appV2Response:async(request,handler)=>handler()},
 '@/lib/api':{ok:data=>response({code:0,message:'ok',data}),fail:(code,message,status)=>response({code,message},{status})}
};
function load(relative){let m={exports:{}};const code=transformSync(fs.readFileSync(path.join(root,relative),'utf8'),{loader:'ts',format:'cjs'}).code;new Function('require','module','exports',code)(key=>{if(key==='@/app/api/v1/fire-settings/route')return load('app/api/v1/fire-settings/route.ts');if(!(key in dependencies))throw Error('Unexpected route dependency');return dependencies[key];},m,m.exports);return m.exports;}
(async()=>{let out=[];for(const action of input){const route=load(`app/api/v${action.version}/fire-settings/route.ts`);const req=new Request('http://synthetic.invalid/fire-settings',{method:action.method,...(action.method==='PUT'?{body:JSON.stringify(action.body),headers:{'Content-Type':'application/json'}}:{})});let r=await route[action.method](req);out.push({status:r.status,body:await r.json()});}process.stdout.write(JSON.stringify(out));})().catch(e=>{console.error(e.message);process.exit(1)});
