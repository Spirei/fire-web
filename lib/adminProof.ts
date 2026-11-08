"use client";
import { startAuthentication } from "@simplewebauthn/browser";
import { appPrompt } from "@/lib/appDialog";
import { passkeyRead, passkeyRequest, passkeyError } from "@/lib/passkeyClient";
export const SESSION_PROOF = 'verified-session-v1';
export type AdminProof = {password:string;code:string};
let pending:Promise<AdminProof|null>|undefined;
/** One shared verification: actual strong session, WebAuthn, or password + configured factor. */
export function requestAdminProof():Promise<AdminProof|null> {
  return pending??=verify().finally(()=>{pending=undefined;});
}
async function verify():Promise<AdminProof|null> {
  const state=await passkeyRead('/api/auth/passkeys/verification');
  if(state.verified===true)return {password:SESSION_PROOF,code:''};
  if(state.passkeyAvailable===true){
    if(!window.isSecureContext||!window.PublicKeyCredential)throw Error('请在支持通行密钥的 HTTPS 页面完成验证');
    try{
      const {options,requestId}=await passkeyRequest({action:'verify-options'});
      const response=await startAuthentication({optionsJSON:options});
      const result=await passkeyRequest({action:'verify-session',requestId,response});
      if(result.ok!==true)throw Error('验证结果尚未确认，请重新读取');
      return {password:SESSION_PROOF,code:''};
    }catch(e){if(e instanceof Error&&['NotAllowedError','AbortError'].includes(e.name))return null;throw Error(passkeyError(e));}
  }
  const password=await appPrompt('请输入管理员密码',{title:'安全验证',inputType:'password'});
  if(!password)return null;
  const code=state.totpEnabled?await appPrompt('请输入二次验证码或备用码',{title:'安全验证'}):'';
  if(state.totpEnabled&&!code)return null;
  return {password,code:code||''};
}
