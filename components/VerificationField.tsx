"use client";
import { useEffect, useRef, useState, type ComponentProps, type ChangeEvent } from "react";
import { IconFingerprint, IconCircleCheck } from "@tabler/icons-react";
import PasswordInput from "./PasswordInput";
import { Capsule } from "./Capsule";
import { requestAdminProof, SESSION_PROOF } from "@/lib/adminProof";
import { passkeyRead } from "@/lib/passkeyClient";
import { showToast } from "@/lib/toast";

/** Current-identity proof only. New passwords and login fields never use this component. */
export default function VerificationField(props:ComponentProps<typeof PasswordInput>) {
  const [available,setAvailable]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[read,setRead]=useState(0),[error,setError]=useState("");
  const onChange=useRef(props.onChange);onChange.current=props.onChange;
  const current=useRef(props.value);current.current=props.value;
  const live=useRef(true);
  const accept=()=>onChange.current?.({target:{value:SESSION_PROOF},currentTarget:{value:SESSION_PROOF}} as ChangeEvent<HTMLInputElement>);
  useEffect(()=>{
    live.current=true;const c=new AbortController();
    passkeyRead('/api/auth/passkeys/verification',c.signal).then(state=>{
      if(c.signal.aborted)return;
      setAvailable(state.passkeyAvailable===true||state.verified===true);
      if(state.verified===true&&current.current!==SESSION_PROOF)accept();
    }).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'验证方式读取失败');});
    return()=>{live.current=false;c.abort();};
  },[read]);
  if(props.value===SESSION_PROOF)return <span className="verification-field-status" role="status"><IconCircleCheck size={18}/>身份已验证</span>;
  if(error)return <Capsule variant="ghost" onClick={()=>{setError("");setRead(n=>n+1);}}>重新读取验证方式</Capsule>;
  if(available===null)return <span className="verification-field-status" role="status">正在读取验证方式…</span>;
  if(!available)return <PasswordInput {...props}/>;
  return <Capsule variant="secondary" busy={busy} disabled={props.disabled} onClick={async()=>{
    if(busy)return;setBusy(true);
    try{const proof=await requestAdminProof();if(live.current&&proof?.password===SESSION_PROOF)accept();}
    catch(e){if(live.current)showToast(e instanceof Error?e.message:'验证失败','err');}
    finally{if(live.current)setBusy(false);}
  }}><IconFingerprint size={20}/>使用通行密钥验证</Capsule>;
}
