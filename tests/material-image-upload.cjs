const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const calls=[];let mode='normal';
async function request(url,options={}){
 calls.push({url,...options});
 if(url==='/api/fire/session')return Response.json({csrf:'synthetic-binding'});
 if(url.includes('/catalog?'))return Response.json({revision:7});
 assert.equal(options.headers['x-csrf-token'],'synthetic-binding');
 if(url==='/api/admin/shared-assets')return Response.json({revision:12});
 if(url.endsWith('/upload')){
  assert.equal(options.body.get('assetId'),'broker:IBKR');assert.equal(options.body.get('catalogRevision'),'7');assert.equal(options.body.get('expectedRevision'),'12');
  if(mode!=='normal')throw Error('response lost');
 }
 if(mode==='failed')return Response.json({state:'failed',message:'共享素材已变化，请重新读取'});
 return Response.json({state:'completed',url:'/uploads/asset/broker/IBKR.png?sha256=synthetic',legacyUrl:'/uploads/asset/broker/IBKR.png'});
}
function load(file){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>load(path.resolve(path.dirname(file),id+'.ts')),fetch:request,crypto:require('node:crypto').webcrypto,FormData,AbortSignal});return exports;}
const upload=load(path.resolve('lib/materialImageUpload.ts')).uploadMaterialImage;
(async()=>{
 const item={id:'broker:IBKR',type:'broker',market:'OTHER',code:'IBKR',name:'IBKR'},file=new File(['synthetic'],'original.png',{type:'image/png'});
 const result=await upload(file,item);assert.equal(result.id,item.id);assert(result.imageUrl.includes('sha256='));assert(!calls.some(c=>c.url==='/api/assets'),'No second metadata write after publication');
 mode='lost';calls.length=0;await upload(file,item);assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.url.includes('/operations/')).length,1,'Lost response only reads original operation');
 mode='failed';await assert.rejects(upload(file,item),/共享素材已变化/);
 console.log('PASS image upload atomically binds the original ID and reconciles a lost response without repeating publication');
})().catch(error=>{console.error(error);process.exit(1)});
