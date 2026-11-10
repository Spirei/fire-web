const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
function load(file){const context={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);return context.exports;}
const {selectMigrationPreparation:select}=load('lib/databaseMigration.ts'),{migrationMapping:restore,migrationStorageKey:key,sameMigrationMapping:same}=load('lib/migrationDraft.ts');
const original={id:'original',request_id:'first',source_revision:'source',status:'succeeded',has_imports:true,result:{phase:'awaiting_mapping',source:{restore_verified:true},target:{restore_verified:true}}};
const newer={...original,id:'newer',request_id:'next',has_imports:false};
assert.equal(select([newer,original],'source').id,'original');assert.equal(select([newer,original],'source','next').id,'newer');assert.equal(select([original],'other'),undefined);assert.equal(select([original],'source','unknown'),undefined);
const scope={users:[{id:'owner'}],accounts:[{id:'a',owner_id:'owner',kind:null},{id:'b',owner_id:'other',kind:'real'}],broker_labels:[{label:'old'}],orders:[{id:'o',owner_id:'owner'}]};
const mapping={source_owner:'owner',account_kinds:{a:'real'},broker_labels:{old:'a'},market_accounts:{US:'a'},order_accounts:{o:'a'}};
assert(same(mapping,restore(mapping,scope)));const foreign=restore({...mapping,account_kinds:{a:'real',b:'real'},broker_labels:{old:'b'},market_accounts:{US:'b'},order_accounts:{o:'b'}},scope);assert.equal(foreign.account_kinds.b,undefined);assert.equal(foreign.market_accounts.US,undefined);assert.equal(foreign.broker_labels.old,undefined);assert.equal(foreign.order_accounts.o,undefined);
assert(same({...mapping,market_accounts:{US:'a',HK:'a'}},{...mapping,market_accounts:{HK:'a',US:'a'}}));assert(!same(mapping,{...mapping,market_accounts:{}}));
assert.notEqual(key('draft','instance','owner','p'),key('draft','instance','other','p'));assert.notEqual(key('draft','instance','owner','p'),key('draft','other','owner','p'));assert.notEqual(key('draft','instance','owner','p'),key('draft','instance','owner','q'));
console.log('PASS migration resumes imported work, restores only current source choices, isolates view drafts and compares mapping values without key-order changes');
