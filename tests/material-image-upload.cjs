const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const calls=[];let mode='normal';
async function request(url,options={}){
 calls.push({url,...options});
 if(url==='/api/fire/session'){
  if(mode==='session-failed')return Response.json({error:'会话不可读'},{status:503});
  return Response.json({csrf:'synthetic-binding'});
 }
 if(url.includes('/catalog?'))return Response.json({revision:7});
 assert.equal(options.headers['x-csrf-token'],'synthetic-binding');
 if(url==='/api/admin/shared-assets')return Response.json({revision:12});
 if(url.endsWith('/upload')){
  assert.match(options.body.get('requestId'),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(options.body.get('assetId'),'broker:IBKR');assert.equal(options.body.get('catalogRevision'),'7');assert.equal(options.body.get('expectedRevision'),'12');
  if(mode==='rejected')return Response.json({error:'图片过大'},{status:413});
  if(mode==='failed-direct')return Response.json({state:'failed',message:'像素超出限制'},{status:422});
  if(mode!=='normal')throw Error('response lost');
 }
 if(mode==='unknown')return Response.json({error:'未找到原素材操作'},{status:404});
 if(mode==='failed')return Response.json({state:'failed',message:'共享素材已变化，请重新读取'});
 return Response.json({state:'completed',url:'/uploads/asset/broker/IBKR.png?sha256=synthetic',legacyUrl:'/uploads/asset/broker/IBKR.png'});
}
function load(file){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>load(path.resolve(path.dirname(file),id+'.ts')),fetch:request,crypto:{getRandomValues:array=>require('node:crypto').randomFillSync(array)},FormData,AbortSignal});return exports;}
const {uploadMaterialImage:upload,MaterialUploadPending}=load(path.resolve('lib/materialImageUpload.ts'));
(async()=>{
 const item={id:'broker:IBKR',type:'broker',market:'OTHER',code:'IBKR',name:'IBKR'},file=new File(['synthetic'],'original.png',{type:'image/png'});
 const result=await upload(file,item);assert.equal(result.id,item.id);assert(result.imageUrl.includes('sha256='));assert(!calls.some(c=>c.url==='/api/assets'),'No second metadata write after publication');
 mode='lost';calls.length=0;await upload(file,item);assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.url.includes('/operations/')).length,1,'Lost response only reads original operation');
 mode='failed';await assert.rejects(upload(file,item),/共享素材已变化/);
 mode='failed-direct';calls.length=0;await assert.rejects(upload(file,item),/像素超出限制/);assert(!calls.some(c=>c.url.includes('/operations/')));
 mode='rejected';calls.length=0;await assert.rejects(upload(file,item),/图片过大/);assert(!calls.some(c=>c.url.includes('/operations/')));
 mode='unknown';calls.length=0;
 let requestId;
 await assert.rejects(upload(file,item,{ownerId:'fixture-owner'}),error=>{
  assert(error instanceof MaterialUploadPending);requestId=error.requestId;return true;
 });
 assert.equal(requestId,calls.find(c=>c.method==='POST').body.get('requestId'));
 assert(calls.every(c=>c.headers['X-Alcor-Expected-Account']==='fixture-owner'));
 mode='session-failed';calls.length=0;
 await assert.rejects(upload(file,item,{ownerId:'fixture-owner',pendingRequestId:requestId}),error=>error instanceof MaterialUploadPending&&error.requestId===requestId);
 mode='normal';calls.length=0;
 await upload(file,item,{ownerId:'fixture-owner',pendingRequestId:requestId});
 assert.deepEqual(calls.map(c=>c.url),['/api/fire/session','/api/admin/shared-assets/operations/'+requestId]);
 console.log('PASS image upload keeps the original asset ID, handles definitive failures, and checks the original UUID on retry without republishing');
})().catch(error=>{console.error(error);process.exit(1)});
