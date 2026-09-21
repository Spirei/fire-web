import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'fire-server-test-'));
const worker = path.join(temp,'worker.mjs');
await fs.writeFile(worker, `import fs from 'node:fs/promises';import path from 'node:path';
import http from 'node:http';
console.log('FIRE_EVENT '+JSON.stringify({message:'测试处理'}));
await new Promise(r=>setTimeout(r,250));
const output=path.join(process.argv[3],path.basename(path.dirname(process.argv[2])));await fs.mkdir(output,{recursive:true});
await fs.copyFile(process.argv[2],path.join(output,'car-optimized.glb'));
console.log('FIRE_EVENT '+JSON.stringify({output}));`);
let descendant;
const tool = await startServer({openBrowser:false,outputRoot:path.join(temp,'out'),worker});
try {
 const page = await (await fetch(tool.origin)).text(); const token=page.match(/const token='([a-f0-9]+)'/)[1]; const headers={'X-Fire-Token':token};
 assert.equal((await fetch(tool.origin+'/api/jobs')).status,403);
 assert.equal((await fetch(tool.origin+'/api/jobs',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
 assert.equal(await new Promise((resolve,reject)=>{const req=http.get(tool.origin+'/api/jobs',{headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)}),403);
 assert.equal((await fetch(tool.origin+'/api/upload?name=..%2Fbad.glb',{method:'POST',headers,body:'abc'})).status,400);
 const bytes=Buffer.alloc(1024*1024+57,42);
 for(let i=0;i<2;i++) assert.equal((await fetch(tool.origin+'/api/upload?name='+encodeURIComponent(`车模 ${i}.glb`),{method:'POST',headers,body:bytes})).status,202);
 let jobs=await (await fetch(tool.origin+'/api/jobs',{headers})).json();assert(jobs.filter(j=>j.state==='running').length<=1);assert(jobs.some(j=>j.state==='queued'));
 for(let i=0;i<100;i++){jobs=await (await fetch(tool.origin+'/api/jobs',{headers})).json();if(jobs.every(j=>j.state==='done'))break;await new Promise(r=>setTimeout(r,30));}
 assert(jobs.every(j=>j.state==='done'),JSON.stringify(jobs));
 const file=await fetch(`${tool.origin}/download?id=${jobs[0].id}&file=car-optimized.glb&token=${token}`);
 assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes,'streamed input and download preserve all bytes');
 assert.equal((await fetch(`${tool.origin}/download?id=${jobs[0].id}&file=../../outside&token=${token}`)).status,404);
 assert.equal((await fetch(tool.origin+'/api/upload?name=empty.glb',{method:'POST',headers,body:''})).status,400);
 await fs.writeFile(worker, `import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(path.join(process.argv[3],'child.pid'),String(child.pid));setInterval(()=>{},1000);`);
 await fetch(tool.origin+'/api/upload?name=stop-test.glb',{method:'POST',headers,body:bytes});
 for(let i=0;i<100;i++){try{descendant=Number(await fs.readFile(path.join(temp,'out','child.pid'),'utf8'));break}catch{}await new Promise(r=>setTimeout(r,20));}
 assert(descendant,'long-running worker started');
 console.log('PASS loopback UI, token/Origin/Host gates, queue isolation, Chinese filenames, byte-exact streaming download and invalid input');
} finally {
 await tool.close();
 if(descendant){let alive=true;for(let i=0;i<100;i++){try{process.kill(descendant,0)}catch(error){if(error.code==='ESRCH'){alive=false;break}}await new Promise(r=>setTimeout(r,20));}assert.equal(alive,false,'closing the tool stops encoder descendants');console.log('PASS shutdown stops the worker and encoder process tree');}
 await fs.rm(temp,{recursive:true,force:true});
}
