// Source-owned illustrations remain available with an empty uploads volume.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const media = JSON.parse(readFileSync(new URL('contracts/system-media.json',root),'utf8'));
// This directory contains generated copies only; never touch original uploads.
rmSync(new URL('public/fire-assets/system/',root), {recursive:true, force:true});
for (const name of media) {
  const target = new URL('public/fire-assets/system/'+name,root);
  mkdirSync(new URL('./',target), {recursive:true});
  copyFileSync(new URL('public/uploads/feature/'+name,root), target);
}
