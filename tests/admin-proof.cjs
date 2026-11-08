const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vm=require('node:vm');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/adminProof.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(state){const calls=[],prompts=[];let cancel=false;const mocks={
 '@simplewebauthn/browser':{startAuthentication:async()=>{calls.push('webauthn');if(cancel)throw Object.assign(Error('canceled'),{name:'NotAllowedError'});return {id:'signed'};}},
 '@/lib/appDialog':{appPrompt:async q=>{prompts.push(q);return q.includes('密码')?'synthetic-password':'123456';}},
 '@/lib/passkeyClient':{passkeyRead:async()=>state,passkeyError:e=>e.message,passkeyRequest:async body=>{calls.push(body.action);return body.action==='verify-options'?{options:{challenge:'test'},requestId:'bound'}:{ok:true};}}
 };const context={exports:{},require:id=>mocks[id],Error,window:{isSecureContext:true,PublicKeyCredential:class{}}};vm.runInNewContext(code,context);return{proof:context.exports.requestAdminProof,calls,prompts,cancel(){cancel=true;}};}
(async()=>{
 let h=setup({verified:true,passkeyAvailable:true,totpEnabled:true});assert.equal((await h.proof()).password,'verified-session-v1');assert.equal(h.calls.length+h.prompts.length,0);
 h=setup({verified:false,passkeyAvailable:true,totpEnabled:true});const [a,b]=await Promise.all([h.proof(),h.proof()]);assert.equal(a.password,b.password);assert.deepEqual(h.calls,['verify-options','webauthn','verify-session']);assert.equal(h.prompts.length,0);
 h=setup({passkeyAvailable:true});h.cancel();assert.equal(await h.proof(),null);assert.equal(h.prompts.length,0,'cancel must not fall back to password');
 h=setup({verified:false,passkeyAvailable:false,totpEnabled:true});assert.equal((await h.proof()).code,'123456');assert.equal(h.prompts.length,2);
 console.log('PASS shared verification: actual strong session, one bound WebAuthn ceremony, cancellation and legacy password/TOTP');
})().catch(e=>{console.error(e);process.exitCode=1;});
