// Actual old TS service in a proven in-memory SQLite fixture. No legacy server,
// on-disk database, config, credential, network or provider module can be loaded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = process.argv[2];
const DB = createRequire(path.join(root, 'package.json'))('better-sqlite3');
const db = new DB(':memory:');
if (!db.memory) throw new Error('Golden must remain in memory');
db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,nickname TEXT,email TEXT,avatar TEXT); INSERT INTO users VALUES(\'synthetic-owner\',\'Synthetic\',\'\',\'\',\'\');');
const grant = {id:'synthetic-grant', user_id:'synthetic-owner', client_id:'fire-ios', scope:'portfolio.read portfolio.write'};
function compile(source, dependencies) {
  const module = {exports:{}};
  const context = vm.createContext({module, exports:module.exports, Buffer, URL, Request, Response,
    require(name) { if (!(name in dependencies)) throw new Error('Disallowed golden dependency: '+name); return dependencies[name]; }});
  vm.runInContext(ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText, context);
  return module.exports;
}
const read = name => fs.readFileSync(path.join(root,'lib',name),'utf8');
const schema = compile(read('appSyncSchema.ts'), {'node:crypto':crypto});
const api = compile(read('api.ts'), {'next/server':{NextResponse:{json:Response.json.bind(Response)}}});
const records = read('recordsContract.ts');
const failureClass = records.slice(records.indexOf('export class RecordsError'), records.indexOf('export function recordsDiscovery'));
const identifier = records.slice(records.indexOf('export function validRecordRequestId'), records.indexOf('type Kind ='));
const contract = compile(failureClass + '\n' + identifier, {});
const service = compile(read('appSync.ts'), {
  'node:crypto':crypto, './db':{getDb:()=>db}, './appAuth':{APP_CLIENT_ID:'fire-ios',authenticateAppAccess:()=>grant},
  './appSyncSchema':schema,'./requestBody':{readJsonBody:async r=>r.json()},'./api':api,'./recordsContract':contract,
  './rateLimit':{rateLimit:()=>true},
});
(async()=>{
  const actions = JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const values = [];
  for (const action of actions) {
    const url = 'http://fixture.invalid/api/v2/app-state'+(action.kind==='read'?'?namespace='+action.namespace:'');
    const request = new Request(url, {method:action.kind==='submit'?'POST':'GET',headers:{authorization:'Bearer fat_'+'a'.repeat(43),'content-type':'application/json'},...(action.kind==='submit'?{body:JSON.stringify(action.body)}:{})});
    const response = await service.appStateResponse(request,action.kind==='receipt'?action.requestId:undefined);
    values.push({status:response.status,body:await response.json()});
  }
  const state = db.prepare('SELECT field,revision,value FROM app_state_fields ORDER BY field').all();
  db.close();process.stdout.write(JSON.stringify({memoryOnly:true,actions:values,finalRows:state}));
})().catch(error=>{db.close();process.stderr.write(String(error.stack));process.exitCode=1;});
