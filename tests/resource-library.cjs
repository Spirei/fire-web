// Real App handlers, independent SQLite users and disk fixtures; never use live data.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'alcor-resource-')));process.chdir(temp);fs.mkdirSync('data');fs.writeFileSync('data/backup-config.json','{"enabled":false}');
process.env.STOCKLOG_FUTU='off';process.env.STOCKLOG_PROXY='off';process.env.FIRE_APP_ORIGIN='https://resource.example.test:18520';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),native=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/resourceLibrary.ts'),bodies=load('lib/requestBody.ts'),config=load('lib/resourceLibraryConfig.ts');
const routes=[null,load('app/api/v1/resource-library/[[...action]]/route.ts'),load('app/api/v2/resource-library/[[...action]]/route.ts')],origin=process.env.FIRE_APP_ORIGIN,password='Resource-library-test-123';let serial=0,count=0;
const grant=(user,scope='portfolio.read resources.read resources.write')=>db.transaction(()=>native.createNativeAppGrant(user.id,scope,'Resource test')).immediate();
const fixture=()=>{const user=auth.createUser('resource_'+(++serial),password),other=auth.createUser('resource_other_'+serial,password);return {user,other,grant:grant(user),otherGrant:grant(other)};};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
const requestId=()=>crypto.randomUUID(),location=(u,id)=>path.join('data/resource-library',crypto.createHash('sha256').update(u.id).digest('hex'),id);
const uploadBody=(bytes=png,name='相片.png',category='media',id=requestId(),extra={})=>{const f=new FormData();f.append('file',new File([bytes],name,{type:'application/octet-stream'}));f.append('category',category);f.append('requestId',id);for(const[k,v]of Object.entries(extra))f.append(k,v);return f;};
async function response(v,action='',method='GET',body,token,headers={}){
 const req=new Request(origin+`/api/v${v}/resource-library`+(action?(action.startsWith('?')?'':'/')+action:''),{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined&&!(body instanceof FormData)?{'content-type':'application/json'}:{}),...headers},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
 return routes[v][method](req,{params:Promise.resolve({action:action.split('?')[0].split('/').filter(Boolean)})});
}
async function call(...args){const r=await response(...args);return {status:r.status,headers:r.headers,...await r.json()};}
const upload=(v,f,bytes=png,name='相片.png',category='media',id=requestId(),extra={})=>call(v,'files','POST',uploadBody(bytes,name,category,id,extra),f.grant.access_token);
const direct=(f,name,bytes=png,category='media',id=requestId())=>store.uploadResource(f.user.id,bytes,{name,category,requestId:id},2);
// Construct the native wire bytes ourselves: FormData serializes quotes differently from Swift.
function nativeMultipart(v, token, name, id, options={}) {
 const boundary='AlcorNativeOriginalName-'+id,part=(key,value,type)=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"${type?'; filename="field.bin"':''}\r\n${type?'Content-Type: application/octet-stream':'Content-Type: text/plain; charset=UTF-8'}\r\n\r\n${value}\r\n`,'utf8');
 const transportName=options.quotedHeader?name.replace(/"/g,'\\"'):'upload.bin',parts=[part('category','media'),part('requestId',id)];
 if(!options.noName)parts.push(part('name',name,options.binaryName));
 if(options.duplicateName)parts.push(part('name',name));
 parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${transportName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,'utf8'),png,Buffer.from(`\r\n--${boundary}--\r\n`,'utf8'));
 return new Request(origin+`/api/v${v}/resource-library/files`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':`multipart/form-data; boundary=${boundary}`},body:Buffer.concat(parts)});
}
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('same-version discovery, stable category/type/sort/limits, optional scopes and unchanged login',async()=>{
  for(const v of [1,2]){
   const r=await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(origin+`/api/v${v}/auth/config`)),d=(await r.json()).data;
   assert.equal(d.scope,native.APP_SCOPE);assert.equal(d.scope,'portfolio.read portfolio.write');assert.deepEqual(d.resource_library,config.resourceLibraryDiscovery(v));
   assert.deepEqual(d.resource_library.categories.map(x=>x.id),['components','media']);assert.deepEqual(d.resource_library.file_kinds,['image','video','audio','document','archive','other']);
   assert(d.scopes_supported.includes('resources.read'));assert(d.scopes_supported.includes('resources.write'));
  }
  const f=fixture();assert.throws(()=>grant(f.user,'portfolio.read resources.write'));
  const permissions=load('app/api/v2/auth/permissions/route.ts'),base=grant(f.user,native.APP_SCOPE);
  const upgrade=async(scope,pwd=undefined)=>{const r=await permissions.POST(new Request(origin+'/api/v2/auth/permissions',{method:'POST',headers:{authorization:'Bearer '+base.access_token,'content-type':'application/json'},body:JSON.stringify({client_id:'fire-ios',scope,currentPassword:pwd})}));return {status:r.status,...await r.json()};};
  assert.equal((await upgrade('resources.write')).status,403);assert.equal((await upgrade('resources.read resources.write',undefined)).status,200);
  const elevated=await upgrade('resources.read resources.write');assert.equal(elevated.status,200);assert(elevated.data.scope.includes('resources.write'));assert(native.authenticateAppAccess(base.access_token,new Request(origin+'/api/v2/auth/me')));
  for(const v of [1,2])assert.equal((await call(v,'','GET',undefined,elevated.data.access_token)).status,200);
 });
 await test('App Bearer only on both versions, missing scopes 403, wrong origin/revoked token, no Cookie supplementation',async()=>{
  const f=fixture(),base=grant(f.user,native.APP_SCOPE),read=grant(f.user,'portfolio.read resources.read'),cookie=auth.createSession(f.user.id);
  for(const v of [1,2]){
   for(const headers of [{cookie:'fire_session='+cookie},{authorization:'Bearer '+cookie,cookie:'fire_session='+cookie}])assert.equal((await call(v,'','GET',undefined,undefined,headers)).status,401);
   assert.equal((await call(v,'','GET',undefined,base.access_token,{cookie:'fire_session='+cookie})).status,403);
   assert.equal((await call(v,'files','POST',uploadBody(),read.access_token,{cookie:'fire_session='+cookie})).status,403);
   assert.equal((await call(v,'','GET',undefined,read.access_token)).status,200);
   assert.equal((await call(v,'','GET',undefined,f.grant.access_token,{origin:'https://evil.test'})).status,403);
  }
  native.revokeAppGrant(f.grant.grant_id);assert.equal((await call(2,'','GET',undefined,f.grant.access_token)).status,401);
 });
 await test('real upload writes isolated original, server MIME, private full/Range download and persisted operation',async()=>{
  const f=fixture(),id=requestId(),r=await upload(1,f,png,'测试相片.png','media',id);assert.equal(r.status,201);const item=r.data;
  assert.equal(item.kind,'image');assert.equal(item.mime,'image/png');assert.equal(item.sha256,crypto.createHash('sha256').update(png).digest('hex'));assert.equal(item.sizeBytes,png.length);
  assert.deepEqual(fs.readFileSync(location(f.user,item.id)),png);assert(!fs.existsSync('public/uploads'));assert(!JSON.stringify(item).includes(f.user.id));
  assert.match(item.downloadPath,/^\/api\/v1\/resource-library\/files\/rlf_[a-f0-9]{32}\/content$/);
  for(const v of [1,2]){
   const full=await response(v,`files/${item.id}/content`,'GET',undefined,f.grant.access_token);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),png);assert.equal(full.headers.get('cache-control'),'private, no-store');assert.equal(full.headers.get('x-content-type-options'),'nosniff');assert.match(full.headers.get('content-disposition'),/^attachment;/);
   for(const[range,start,end]of [['bytes=2-8',2,8],['bytes=-4',png.length-4,png.length-1],['bytes=5-',5,png.length-1]]){const part=await response(v,`files/${item.id}/content`,'GET',undefined,f.grant.access_token,{range});assert.equal(part.status,206);assert.deepEqual(Buffer.from(await part.arrayBuffer()),png.subarray(start,end+1));}
   for(const range of ['bytes=999999-','bytes=1-0','bytes=-0','bytes=0-1,3-4','bytes=-','bytes=999999999999999999-']){const bad=await response(v,`files/${item.id}/content`,'GET',undefined,f.grant.access_token,{range});assert.equal(bad.status,416);assert.equal(bad.headers.get('content-range'),'bytes */'+png.length);}
   const op=await call(v,'uploads/'+id,'GET',undefined,f.grant.access_token);assert.equal(op.data.state,'completed');assert.match(op.data.result.downloadPath,new RegExp('/api/v'+v+'/'));assert.equal(op.data.result.name,'测试相片.png');
  }
  assert.equal((await upload(2,f,png,'测试相片.png','media',id)).status,409);assert.equal(store.resourceUsage(f.user.id).fileCount,1);
 });
 await test('raw native UTF-8 name part preserves Chinese, quotes, literal percent, emoji and NFD across both versions and disk',async()=>{
  const names=['中文相片.png','中文"引号".png','中文%22%0D%0A%25.png','emoji😀.png','Cafe\u0301.png','中文"%22😀\u0301".png'];
  for(const v of [1,2]){
   const f=fixture();assert.equal(config.resourceLibraryDiscovery(v).upload_name_field,'name');
   for(const name of names){
    const id=requestId(),r=await routes[v].POST(nativeMultipart(v,f.grant.access_token,name,id),{params:Promise.resolve({action:['files']})});assert.equal(r.status,201);const item=(await r.json()).data;assert.equal(item.name,name);assert.equal(item.kind,'image');assert.equal(item.mime,'image/png');assert.deepEqual(fs.readFileSync(location(f.user,item.id)),png);
    const metadata=await call(v,'files/'+item.id,'GET',undefined,f.grant.access_token),op=await call(v,'uploads/'+id,'GET',undefined,f.grant.access_token);assert.equal(metadata.data.name,name);assert.equal(op.data.result.name,name);
    const list=await call(v,'files?kind=image&sort=name&direction=asc','GET',undefined,f.grant.access_token);assert.equal(list.data.items.find(x=>x.id===item.id).name,name);
    const content=await response(v,`files/${item.id}/content`,'GET',undefined,f.grant.access_token),encoded=content.headers.get('content-disposition').split("filename*=UTF-8''")[1];assert.equal(decodeURIComponent(encoded),name);assert.deepEqual(Buffer.from(await content.arrayBuffer()),png);
   }
  }
 });
 await test('ambiguous name fields and invalid names reject without writing; legacy UTF-8 filename remains compatible',async()=>{
  for(const v of [1,2]){
   const f=fixture(),invoke=async(name,options={})=>routes[v].POST(nativeMultipart(v,f.grant.access_token,name,requestId(),options),{params:Promise.resolve({action:['files']})});
   for(const options of [{duplicateName:true},{binaryName:true}])assert.equal((await invoke('中文"引号".png',options)).status,400);
   for(const name of ['..','目录/a.png','a\\b.png','a\0.png','a\r\n.png','x'.repeat(121)+'.png'])assert.equal((await invoke(name)).status,400);
   assert.equal(store.resourceUsage(f.user.id).fileCount,0);
   const old=await invoke('旧版中文.png',{noName:true,quotedHeader:true});assert.equal(old.status,201);assert.equal((await old.json()).data.name,'旧版中文.png');
   assert.equal((await invoke('中文"引号".png',{noName:true,quotedHeader:true})).status,400);
  }
 });
 await test('cross-user metadata/download/delete/folders/operations fail 404 without touching either account',async()=>{
  const f=fixture(),id=requestId(),item=(await upload(2,f,png,'a.png','media',id)).data,folder=(await call(2,'folders','POST',{category:'components',name:'Private'},f.grant.access_token)).data;
  for(const v of [1,2]){
   for(const action of [`files/${item.id}`,`files/${item.id}/content`,'uploads/'+id,`files?folderId=${folder.id}`,`folders?category=components&parentId=${folder.id}`])assert.equal((await call(v,action,'GET',undefined,f.otherGrant.access_token)).status,404);
   assert.equal((await call(v,`files/${item.id}`,'DELETE',{revision:1,requestId:requestId()},f.otherGrant.access_token)).status,404);
   assert.equal((await call(v,'folders/'+folder.id,'DELETE',{revision:1},f.otherGrant.access_token)).status,404);
   assert.equal((await call(v,'files','GET',undefined,f.otherGrant.access_token)).data.items.length,0);
  }
  assert(fs.existsSync(location(f.user,item.id)));assert.equal(store.resourceUsage(f.user.id).fileCount,1);
 });
 await test('server type filters and all-category pagination never fake an empty page; name/time sorting and cursor binding',async()=>{
  const f=fixture();for(let i=0;i<37;i++)direct(f,'img-'+String(i).padStart(2,'0')+'.png',png,i%2?'components':'media');
  direct(f,'z-document.txt',Buffer.from('Hello document'),'components');direct(f,'unknown.bin',Buffer.from([0,1,2]),'components');
  for(const v of [1,2]){
   let cursor=null,items=[];do{const r=await call(v,'files?kind=image&sort=name&direction=asc&limit=7'+(cursor?'&cursor='+encodeURIComponent(cursor):''),'GET',undefined,f.grant.access_token);assert.equal(r.status,200);assert(r.data.items.length);items.push(...r.data.items);cursor=r.data.nextCursor;}while(cursor);
   assert.equal(items.length,37);assert.equal(new Set(items.map(x=>x.id)).size,37);assert.deepEqual(items.map(x=>x.name),[...items.map(x=>x.name)].sort());assert(new Set(items.map(x=>x.category)).size===2);
   for(const direction of ['asc','desc']){let next=null,ids=[];do{const part=await call(v,'files?kind=image&sort=createdAt&direction='+direction+'&limit=5'+(next?'&cursor='+encodeURIComponent(next):''),'GET',undefined,f.grant.access_token);assert.equal(part.status,200);ids.push(...part.data.items.map(x=>x.id));next=part.data.nextCursor;}while(next);assert.equal(ids.length,37);assert.equal(new Set(ids).size,37);}
   const page=await call(v,'files?kind=image&limit=1&sort=name&direction=desc','GET',undefined,f.grant.access_token);assert.equal(page.data.items[0].name,'img-36.png');const c=encodeURIComponent(page.data.nextCursor);
   for(const query of ['kind=document&sort=name&direction=desc','kind=image&sort=createdAt&direction=desc','kind=image&sort=name&direction=asc','category=media&kind=image&sort=name&direction=desc'])assert.equal((await call(v,'files?'+query+'&limit=1&cursor='+c,'GET',undefined,f.grant.access_token)).status,400);
   assert.equal((await call(v,'files?kind=image&sort=name&direction=desc&cursor='+c,'GET',undefined,f.otherGrant.access_token)).status,400);
   assert.equal((await call(v,'files?kind=document','GET',undefined,f.grant.access_token)).data.items.length,1);
   assert.equal((await call(v,'files?kind=other','GET',undefined,f.grant.access_token)).data.items.length,1);
   assert.equal((await call(v,'files?kind=video','GET',undefined,f.grant.access_token)).data.nextCursor,null);
   for(const query of ['sort=bad','direction=bad','kind=bad','limit=101','limit=0','category=received','user_id=x','kind=image&kind=other','cursor=garbage'])assert.equal((await call(v,'files?'+query,'GET',undefined,f.grant.access_token)).status,400);
  }
 });
 await test('safe optional folders: root import, category ownership, name/depth conflict and only empty deletion',async()=>{
  const f=fixture(),folder=(await call(2,'folders','POST',{category:'components',name:'Library'},f.grant.access_token)).data;
  assert.equal((await call(2,'folders','POST',{category:'components',name:'Library'},f.grant.access_token)).status,409);
  assert.equal((await upload(2,f,Buffer.from('Text'),'a.txt','components',requestId(),{folderId:folder.id})).status,201);
  assert.equal((await upload(2,f,png,'a.png','media',requestId(),{folderId:folder.id})).status,404);
  assert.equal((await call(2,'folders/'+folder.id,'DELETE',{revision:2},f.grant.access_token)).status,409);
  assert.equal((await call(2,'folders/'+folder.id,'DELETE',{revision:1},f.grant.access_token)).status,409);
  let parent=folder.id;for(let i=2;i<=8;i++)parent=(await call(2,'folders','POST',{category:'components',parentId:parent,name:'Level'+i},f.grant.access_token)).data.id;
  assert.equal((await call(2,'folders','POST',{category:'components',parentId:parent,name:'Level9'},f.grant.access_token)).status,400);
  assert.equal((await call(2,'folders/'+parent,'DELETE',{revision:1},f.grant.access_token)).status,200);
  for(const name of ['../escape','a/b','a\\b','..','\0bad',' 空格','x'.repeat(121),'中文'.repeat(60)])assert.equal((await call(2,'folders','POST',{category:'components',name},f.grant.access_token)).status,400);
  assert.equal((await call(2,'folders?category=components&limit=1','GET',undefined,f.grant.access_token)).data.items.length,1);
 });
 await test('immutable revision deletion physically removes original, quota falls and receipt stays exact without replay',async()=>{
  const f=fixture(),uploadId=requestId(),item=(await upload(2,f,png,'a.png','media',uploadId)).data,deleteId=requestId();
  assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:2,requestId:deleteId},f.grant.access_token)).status,409);assert(fs.existsSync(location(f.user,item.id)));
  const result=await call(1,'files/'+item.id,'DELETE',{revision:1,requestId:deleteId},f.grant.access_token);assert.equal(result.status,200);assert.equal(result.data.fileDeleted,true);assert.equal(result.data.removedBytes,png.length);assert.equal(result.data.usedBytes,0);assert(!fs.existsSync(location(f.user,item.id)));assert.equal(store.resourceUsage(f.user.id).fileCount,0);
  for(const v of [1,2]){const queried=await call(v,'deletions/'+deleteId,'GET',undefined,f.grant.access_token);assert.equal(queried.data.state,'completed');assert.deepEqual(queried.data.result,result.data);assert.equal((await call(v,'files/'+item.id,'DELETE',{revision:1,requestId:deleteId},f.grant.access_token)).status,409);assert.equal((await call(v,'files/'+item.id,'GET',undefined,f.grant.access_token)).status,404);}
  assert.equal((await call(2,'deletions/'+deleteId,'GET',undefined,f.otherGrant.access_token)).status,404);
  const uploadReceipt=await call(2,'uploads/'+uploadId,'GET',undefined,f.grant.access_token);assert.equal(uploadReceipt.data.result.state,'ready');assert.equal(uploadReceipt.data.result.name,'a.png');
 });
 await test('unlink failure never claims freed space; read-only query never retries deletion; explicit later delete succeeds',async()=>{
  const f=fixture(),item=direct(f,'a.png'),id=requestId(),unlink=fs.unlinkSync;fs.unlinkSync=target=>{if(target.endsWith(item.id))throw Error('fixture unlink failure');return unlink(target);};
  try{assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:1,requestId:id},f.grant.access_token)).status,500);}finally{fs.unlinkSync=unlink;}
  assert(fs.existsSync(location(f.user,item.id)));assert.equal(store.resourceUsage(f.user.id).usedBytes,png.length);assert.equal((await call(2,'deletions/'+id,'GET',undefined,f.grant.access_token)).data.state,'pending');assert(fs.existsSync(location(f.user,item.id)));
  assert.equal((await response(2,'files/'+item.id+'/content','GET',undefined,f.grant.access_token)).status,409);
  assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:1,requestId:requestId()},f.grant.access_token)).status,200);assert.equal((await call(2,'deletions/'+id,'GET',undefined,f.grant.access_token)).data.result.fileDeleted,true);
 });
 await test('uncertain post-unlink DB acknowledgement reconciles receipt after module restart without removing anything twice',async()=>{
  const f=fixture(),item=direct(f,'a.png'),id=requestId(),prepare=db.prepare;
  db.prepare=function(sql){if(sql.startsWith("UPDATE resource_files SET state='deleted'"))throw Error('fixture DB acknowledgement failure');return prepare.call(this,sql);};
  try{assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:1,requestId:id},f.grant.access_token)).status,500);}finally{db.prepare=prepare;}
  assert(!fs.existsSync(location(f.user,item.id)));delete require.cache[require.resolve(path.join(root,'lib/resourceLibrary.ts'))];const restarted=load('lib/resourceLibrary.ts'),receipt=restarted.resourceOperation(f.user.id,id,'delete',2);assert.equal(receipt.state,'completed');assert.equal(receipt.result.removedBytes,png.length);assert.equal(receipt.result.usedBytes,0);
  const again=restarted.resourceOperation(f.user.id,id,'delete',1);assert.deepEqual(again.result,receipt.result);
 });
 await test('partial upload disk failure cleans staging; completed original with uncertain metadata is queried, not uploaded again',async()=>{
  const f=fixture(),id=requestId(),write=fs.writeFileSync;fs.writeFileSync=function(target,bytes,...rest){if(typeof target==='number'){write.call(this,target,Buffer.from('partial'));throw Error('fixture disk full');}return write.call(this,target,bytes,...rest);};
  try{assert.equal((await upload(2,f,png,'a.png','media',id)).status,500);}finally{fs.writeFileSync=write;}
  assert.equal(store.resourceUsage(f.user.id).fileCount,0);assert.equal(fs.readdirSync(path.dirname(location(f.user,'x'))).length,0);assert.equal((await call(2,'uploads/'+id,'GET',undefined,f.grant.access_token)).data.state,'failed');
  const next=requestId(),prepare=db.prepare;db.prepare=function(sql){if(sql.startsWith("UPDATE resource_files SET state='ready'"))throw Error('fixture DB finalization failure');return prepare.call(this,sql);};
  try{assert.equal((await upload(2,f,png,'b.png','media',next)).status,500);}finally{db.prepare=prepare;}
  assert.equal(store.resourceUsage(f.user.id).usedBytes,png.length);const confirmed=await call(2,'uploads/'+next,'GET',undefined,f.grant.access_token);assert.equal(confirmed.data.state,'completed');assert.equal(confirmed.data.result.name,'b.png');assert.deepEqual(fs.readFileSync(location(f.user,confirmed.data.fileId)),png);
 });
 await test('format/body/byte/quota/file-count limits apply before disk; six kinds and other are classified by server',async()=>{
  const f=fixture();for(const [name,bytes,kind]of [['a.png',png,'image'],['a.mp4',Buffer.from('000000186674797069736f6d00000000','hex'),'video'],['a.wav',Buffer.from('524946460000000057415645','hex'),'audio'],['a.txt',Buffer.from('文本'),'document'],['a.zip',Buffer.from('504b050600000000','hex'),'archive'],['a.data',Buffer.from([1,2,3]),'other']])assert.equal(direct(f,name,bytes,kind==='other'||kind==='document'||kind==='archive'?'components':'media').kind,kind);
  for(const[name,bytes,status]of [['bad.png',Buffer.from('text'),415],['bad.json',Buffer.from('{oops'),415],['bad.txt',Buffer.from([255]),415],['zero.png',Buffer.alloc(0),413]])assert.equal((await upload(2,f,bytes,name,'components')).status,status);
  assert.equal((await upload(2,f,Buffer.from('text'),'a.txt','media')).status,415);
  assert.equal((await upload(2,f,png,'a.png','media',requestId(),{user_id:f.other.id})).status,400);
  const over=await response(2,'files','POST',uploadBody(),f.grant.access_token,{'content-length':String(config.RESOURCE_UPLOAD_LIMIT+65537)});assert.equal(over.status,413);
  const malformed=new Request(origin+'/api/v2/resource-library/files',{method:'POST',body:'bad',headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'multipart/form-data; boundary=missing'}});assert.equal((await routes[2].POST(malformed,{params:Promise.resolve({action:['files']})})).status,400);
  const row=db.prepare('SELECT id FROM resource_files WHERE user_id=? LIMIT 1').get(f.user.id);db.prepare('UPDATE resource_files SET size_bytes=? WHERE id=?').run(config.RESOURCE_QUOTA,row.id);assert.equal((await upload(2,f)).status,409);
  db.prepare('UPDATE resource_files SET size_bytes=1 WHERE user_id=?').run(f.user.id);const add=db.prepare('INSERT INTO resource_files SELECT ?,user_id,category,folder_id,name,kind,mime,0,sha256,revision,created_at,state FROM resource_files WHERE id=?');db.transaction(()=>{for(let i=6;i<5000;i++)add.run('rlf_'+crypto.randomBytes(16).toString('hex'),row.id);})();assert.equal((await upload(2,f)).status,409);
  assert.throws(()=>store.uploadResource(f.user.id,Buffer.alloc(config.RESOURCE_UPLOAD_LIMIT+1),{name:'too.bin',category:'components',requestId:requestId()},2),e=>e.status===413);
 });
 await test('original absent before deletion is not falsely reported as removed; stale staging reconciles only its own operation',async()=>{
  const f=fixture(),item=direct(f,'missing.png'),target=location(f.user,item.id);fs.unlinkSync(target);
  assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:1,requestId:requestId()},f.grant.access_token)).status,500);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM resource_operations WHERE user_id=? AND type='delete'").get(f.user.id).n,0);
  const stagingId=requestId(),staged=direct(f,'staged.png',png,'media',stagingId),stagedPath=location(f.user,staged.id);fs.renameSync(stagedPath,stagedPath+'.part');
  db.prepare("UPDATE resource_files SET state='uploading' WHERE id=?").run(staged.id);db.prepare("UPDATE resource_operations SET state='pending',result=NULL,created_at=? WHERE user_id=? AND request_id=?").run(new Date(Date.now()-120000).toISOString(),f.user.id,stagingId);
  const failed=await call(2,'uploads/'+stagingId,'GET',undefined,f.grant.access_token);assert.equal(failed.data.state,'failed');assert(!fs.existsSync(stagedPath+'.part'));assert.equal(store.resourceUsage(f.user.id).fileCount,1);
 });
 await test('real maximum file accepted and returned limit+1 body without Content-Length rejected',async()=>{
  const f=fixture(),bytes=Buffer.alloc(config.RESOURCE_UPLOAD_LIMIT,7),item=direct(f,'large.bin',bytes,'components');assert.equal(fs.statSync(location(f.user,item.id)).size,config.RESOURCE_UPLOAD_LIMIT);store.deleteResource(f.user.id,item.id,{revision:1,requestId:requestId()});
  let sent=0;const stream=new ReadableStream({pull(c){if(sent++<51)c.enqueue(new Uint8Array(1024*1024));else c.close();}});
  const req=new Request(origin+'/api/v2/resource-library/files',{method:'POST',headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'multipart/form-data; boundary=fixture'},body:stream,duplex:'half'});assert.equal((await routes[2].POST(req,{params:Promise.resolve({action:['files']})})).status,413);assert.equal(store.resourceUsage(f.user.id).fileCount,0);
 });
 await test('revoked while consuming multipart/JSON never writes or deletes; server-wide concurrent upload bound releases',async()=>{
  const f=fixture(),read=bodies.readFormBody;bodies.readFormBody=async(...args)=>{const form=await read(...args);native.revokeAppGrant(f.grant.grant_id);return form;};
  try{assert.equal((await upload(2,f)).status,401);}finally{bodies.readFormBody=read;}assert.equal(store.resourceUsage(f.user.id).fileCount,0);
  f.grant=grant(f.user);const item=direct(f,'keep.png'),json=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const result=await json(...args);native.revokeAppGrant(f.grant.grant_id);return result;};
  try{assert.equal((await call(1,'files/'+item.id,'DELETE',{revision:1,requestId:requestId()},f.grant.access_token)).status,401);}finally{bodies.readJsonBody=json;}assert(fs.existsSync(location(f.user,item.id)));
  f.grant=grant(f.user);global.alcorResourceUploads=2;try{assert.equal((await upload(2,f)).status,429);}finally{global.alcorResourceUploads=0;}assert.equal((await upload(2,f)).status,201);assert.equal(global.alcorResourceUploads,0);
 });
 await test('existing account deletion removes its personal originals and metadata without touching another owner',async()=>{
  const f=fixture(),mine=direct(f,'mine.png'),theirs=store.uploadResource(f.other.id,png,{name:'theirs.png',category:'media',requestId:requestId()},2);
  assert.equal(auth.deleteUserById(f.user.id),true);assert(!fs.existsSync(location(f.user,mine.id)));assert(fs.existsSync(location(f.other,theirs.id)));assert.equal(db.prepare('SELECT COUNT(*) n FROM resource_files WHERE user_id=?').get(f.user.id).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM resource_operations WHERE user_id=?').get(f.user.id).n,0);
 });
 await test('filesystem links and path injection cannot read or remove external files or expose business directories',async()=>{
  const f=fixture(),item=direct(f,'a.png'),target=location(f.user,item.id),outside=path.join(temp,'outside.txt');fs.writeFileSync(outside,png);fs.unlinkSync(target);fs.symlinkSync(outside,target);
  assert.equal((await response(2,'files/'+item.id+'/content','GET',undefined,f.grant.access_token)).status,500);assert.equal((await call(2,'files/'+item.id,'DELETE',{revision:1,requestId:requestId()},f.grant.access_token)).status,500);assert.deepEqual(fs.readFileSync(outside),png);fs.unlinkSync(target);fs.linkSync(outside,target);db.prepare("UPDATE resource_files SET state='ready' WHERE id=?").run(item.id);assert.equal((await response(2,'files/'+item.id+'/content','GET',undefined,f.grant.access_token)).status,500);fs.unlinkSync(target);
  const directory=path.dirname(target);fs.rmdirSync(directory);fs.symlinkSync(temp,directory,'dir');assert.equal((await upload(2,f)).status,500);fs.unlinkSync(directory);
  for(const action of ['files/../../outside','folders/system','files?path=data/fire.db','files?category=agents'])assert.equal((await call(2,action,'GET',undefined,f.grant.access_token)).status===404||(await call(2,action,'GET',undefined,f.grant.access_token)).status===400,true);
 });
 console.log(`${count} personal resource-library suites passed (temporary database and original-file fixtures)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
