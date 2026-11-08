const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),files=require('../contracts/system-media.json');
const stale=path.join(root,'public/fire-assets/system/retired/stale.svg');
fs.mkdirSync(path.dirname(stale),{recursive:true}); fs.writeFileSync(stale,'old generated copy');
execFileSync(process.execPath,[path.join(root,'scripts/prepare-system-media.mjs')]);
assert(!fs.existsSync(stale),'regeneration removes retired copies from its owned output only');
assert.deepEqual(fs.readdirSync(path.join(root,'public/fire-assets/system'),{recursive:true}).filter(name=>fs.statSync(path.join(root,'public/fire-assets/system',name)).isFile()).sort(),[...files].sort());
assert.equal(new Set(files).size,files.length);
for(const file of files){assert(/^[a-z0-9/-]+\.(png|webp|mp4)$/.test(file));assert(!file.includes('..'));assert.deepEqual(fs.readFileSync(path.join(root,'public/uploads/feature',file)),fs.readFileSync(path.join(root,'public/fire-assets/system',file)));}
(async()=>{const config=(await import('../next.config.mjs')).default;const rewrites=(await config.rewrites()).beforeFiles;for(const name of files){const i=rewrites.findIndex(row=>row.source==='/uploads/feature/'+name);assert(i>=0&&i<rewrites.findIndex(row=>row.source.includes('uploadPrefix')));assert.equal(rewrites[i].destination,'/fire-assets/system/'+name);}
assert(!rewrites.some(row=>row.source==='/uploads/feature/:path*'),'private or undeclared files do not become public');
console.log('PASS all '+files.length+' built-in media are byte-exact, routed before uploads and independent of an empty uploads mount');})().catch(e=>{console.error(e);process.exitCode=1;});
