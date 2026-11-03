#!/usr/bin/env node
// Offline only: authenticates/decrypts into a NEW private directory. Never connects to or restores a database.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fileHash(file) {
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const hash = createHash('sha256'); let bytes = 0n; for await (const chunk of input.createReadStream({autoClose:false})) { hash.update(chunk); bytes += BigInt(chunk.length); } return {sha256:hash.digest('hex'),bytes:bytes.toString()}; }
  finally { await input.close(); }
}
async function unpackArchive(archive,destination) {
  const code = `import tarfile,pathlib,os,sys,shutil
root=pathlib.Path(sys.argv[2]);seen=set();total=0;count=0
with tarfile.open(sys.argv[1],mode='r|gz',encoding='utf-8',errors='strict') as archive:
 for member in archive:
  name=member.name.rstrip('/');parts=name.split('/');count+=1;total+=member.size
  if not name or name.startswith('/') or any(p in ('.','..','') for p in parts) or any(ord(c)<32 or ord(c)==127 or c=='\\\\' for c in name) or name in seen or parts[0] not in ('manifest.json','seal.json','database.dump','database.toc','tables','files') or count>200000 or total>10*1024**3:raise ValueError('unsafe archive')
  if not member.isfile() and not member.isdir():raise ValueError('special file')
  seen.add(name);target=root.joinpath(*parts)
  if member.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o700)
  else:
   target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'wb') as output,archive.extractfile(member) as source:shutil.copyfileobj(source,output)
`;
  const child = spawn('python3',['-c',code,archive,destination],{env:{PATH:process.env.PATH,LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
  let out='',failure=false;
  child.stderr.on('data',()=>{failure=true;});
  const done=new Promise((resolve,reject)=>{child.on('error',()=>reject(Error('tar unavailable')));child.on('close',code=>code===0&&!failure?resolve():reject(Error('archive validation failed')));});
  void done.catch(()=>{});
  for await(const chunk of child.stdout){out+=chunk.toString();if(out.length>32*1024*1024){child.kill();throw Error('archive listing exceeds limit');}}
  await done;return out;
}
const safePath = name => typeof name === 'string' && name && !name.startsWith('/') && !/[\x00-\x1f\x7f\\]/.test(name) && !name.split('/').some(part=>part==='.'||part==='..'||part==='') && /^(?:manifest\.json|seal\.json|database\.dump|database\.toc|(?:tables|files)(?:\/.*)?)$/.test(name);

export async function verifyMigrationExport({bundle,exportKeyFile,sourceKeyFile,sourceKeyMode='file',output}) {
  const parent=await fs.realpath(path.dirname(path.resolve(output))), target=path.join(parent,path.basename(output));
  if(await fs.lstat(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('output must be a new directory');
  const readSecret=async file=>{const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await h.stat();if(!stat.isFile()||(stat.mode&0o077))throw Error('key files must be private (0600)');return await h.readFile();}finally{await h.close();}};
  const raw=await readSecret(exportKeyFile),encoded=raw.toString('utf8').trim();raw.fill(0);
  if(!/^[A-Za-z0-9_-]{43}$/.test(encoded))throw Error('invalid export key');
  const key=Buffer.from(encoded,'base64url');
  if(key.length!==32||key.toString('base64url')!==encoded)throw Error('invalid export key');
  const original=await readSecret(sourceKeyFile);
  const originalBytes=sourceKeyMode==='environment'?Buffer.from(original.toString('utf8').trim()):original;
  if(!['file','environment'].includes(sourceKeyMode))throw Error('invalid source key mode');
  const sourceFingerprint=sha(Buffer.from(sha(originalBytes),'hex'));originalBytes.fill(0);original.fill(0);
  await fs.mkdir(target,{mode:0o700});
  const archive=path.join(target,'.authenticated-payload.tar.gz');
  try {
    const beforeBundle = await fileHash(bundle);
    const source=await fs.open(bundle,constants.O_RDONLY|constants.O_NOFOLLOW);
    let envelopeId;
    const temporary=await fs.open(archive+'.partial','wx',0o600);
    try {
      const info=await source.stat({bigint:true});
      if(info.size>10n*1024n*1024n*1024n||info.size<32n)throw Error('bundle size invalid');
      const prefix=Buffer.alloc(12);if((await source.read(prefix,0,12,0)).bytesRead!==12||prefix.subarray(0,8).toString()!=='ALCORMX1')throw Error('invalid envelope');
      const length=prefix.readUInt32BE(8);if(length>16384||length<2)throw Error('invalid header');
      const header=Buffer.alloc(length);if((await source.read(header,0,length,12)).bytesRead!==length)throw Error('truncated header');
      const meta=JSON.parse(header.toString('utf8'));
      if(meta.format!=='alcor-unified-migration'||meta.version!==1||meta.cipher!=='AES-256-GCM'||meta.payload!=='tar.gz'||meta.keyDerivation!=='none-32-random-bytes'||!/^mex_[a-f0-9]{32}$/.test(meta.exportId))throw Error('unsupported envelope');
      envelopeId=meta.exportId;
      const nonce=Buffer.from(meta.nonce,'base64url');if(nonce.length!==12)throw Error('invalid nonce');
      const tag=Buffer.alloc(16),end=Number(info.size)-16;
      if((await source.read(tag,0,16,end)).bytesRead!==16||end<=12+length)throw Error('truncated ciphertext');
      const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.concat([prefix,header]));decipher.setAuthTag(tag);
      let clearBytes=0n;
      for await(const chunk of source.createReadStream({start:12+length,end:end-1,autoClose:false})){const bytes=decipher.update(chunk);clearBytes+=BigInt(bytes.length);if(clearBytes>10n*1024n*1024n*1024n)throw Error('payload too large');await temporary.writeFile(bytes);}
      await temporary.writeFile(decipher.final());await temporary.sync();
    } finally {await temporary.close();await source.close();key.fill(0);}
    await fs.rename(archive+'.partial',archive); // No unauthenticated plaintext is ever extracted.
    const unpack=path.join(target,'payload');await fs.mkdir(unpack,{mode:0o700});
    await unpackArchive(archive,unpack);
    if((await fs.stat(path.join(unpack,'manifest.json'))).size>64*1024*1024)throw Error('manifest too large');
    const manifestBytes=await fs.readFile(path.join(unpack,'manifest.json')),manifest=JSON.parse(manifestBytes),seal=JSON.parse(await fs.readFile(path.join(unpack,'seal.json'),'utf8'));
    if(manifest.exportId!==envelopeId||manifest.format!=='alcor-unified-migration'||manifest.formatVersion!==1||manifest.source?.backend!=='postgres'||manifest.source?.driver!=='pg'||manifest.snapshot?.scope!=='all-non-system-database-schemas'||manifest.preservation?.financialProjectionReplay!==false||seal.manifestSha256!==sha(manifestBytes)||manifest.sourceEncryption?.keyIncluded!==false||manifest.sourceEncryption?.keyFingerprintSha256!==sourceFingerprint)throw Error('manifest seal/source key mismatch');
    const files=[manifest.database,manifest.database.toc,...manifest.tables,...manifest.originals.files];
    if(new Set(files.map(file=>file.path)).size!==files.length)throw Error('duplicate manifest path');
    for(const file of files){
      if(!safePath(file.path)||!/^\d+$/.test(file.bytes)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid manifest file');
      const actual=await fileHash(path.join(unpack,file.path));if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error('file digest mismatch');
      if(file.rowCount!==undefined){
        if(!/^\d+$/.test(file.rowCount))throw Error('invalid row count');
        const rows=await fs.open(path.join(unpack,file.path),constants.O_RDONLY|constants.O_NOFOLLOW);let count=0n;
        try{for await(const bytes of rows.createReadStream({autoClose:false}))for(const byte of bytes)if(byte===10)count++;}finally{await rows.close();}
        if(count!==BigInt(file.rowCount))throw Error('table row count mismatch');
      }
    }
    const expected=new Set(['manifest.json','seal.json',...files.map(file=>file.path)]),actual=[];
    const walk=async(relative='')=>{for(const entry of await fs.readdir(path.join(unpack,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(name);else if(entry.isFile())actual.push(name);else throw Error('special file');}};
    await walk();if(actual.length!==expected.size||actual.some(name=>!expected.has(name)))throw Error('unlisted or missing archive original');
    if(String(files.length)!==seal.fileCount||String(manifest.originals.files.length)!==manifest.originals.count)throw Error('manifest counts mismatch');
    const afterBundle=await fileHash(bundle);if(afterBundle.sha256!==beforeBundle.sha256||afterBundle.bytes!==beforeBundle.bytes)throw Error('bundle changed during verification');
    const receipt={format:'alcor-unified-migration-verification',version:1,exportId:manifest.exportId,source:manifest.source,manifestSha256:seal.manifestSha256,bundle:afterBundle,tableCount:String(manifest.tables.length),originalCount:manifest.originals.count,originalSourceKeyVerified:true,envelopeAuthenticated:true,allFileHashesVerified:true,nativeDatabaseRestoreVerified:false,restorePolicy:'isolated-quarantine-only'};
    await fs.writeFile(path.join(target,'verification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
    await fs.unlink(archive);return {receipt,manifest,payload:unpack};
  } catch(error){await fs.rm(target,{recursive:true,force:true});throw error;}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){const key={'--bundle':'bundle','--export-key-file':'exportKeyFile','--source-key-file':'sourceKeyFile','--source-key-mode':'sourceKeyMode','--output':'output'}[args[i]];if(!key||!args[i+1])throw Error('invalid arguments');options[key]=args[i+1];}
  if(!options.bundle||!options.exportKeyFile||!options.sourceKeyFile||!options.output)throw Error('bundle, separate export/source key files and a NEW output directory are required');
  verifyMigrationExport(options).then(({receipt})=>console.log(JSON.stringify(receipt,null,2))).catch(()=>{console.error('Export verification failed; no verified plaintext was retained.');process.exitCode=1;});
}
