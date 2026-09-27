"use client";
import { useEffect,useRef,useState } from "react";
import Link from "next/link";
export default function EmailVerificationResult({token}:{token:string}) {
  const task=useRef<Promise<void>|null>(null);
  const [state,setState]=useState<{busy:boolean;error:string}>({busy:true,error:""});
  useEffect(()=>{
    let active=true;
    if(!task.current) task.current=(async()=>{
      if(!token) throw new Error("确认链接不完整");
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),15000);
      try {
        const response=await fetch("/api/auth/email-verification/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token}),signal:controller.signal});
        const data=await response.json().catch(()=>null);
        if(!response.ok) throw new Error(data?.error||"验证失败");
      } catch(error) { if(controller.signal.aborted) throw new Error("请求超时，请重新打开链接");throw error; }
      finally {clearTimeout(timer);}
    })();
    task.current.then(()=>{if(active){setState({busy:false,error:""});window.dispatchEvent(new Event("fire:user-updated"));}},cause=>{if(active)setState({busy:false,error:cause instanceof Error?cause.message:"验证失败"});});
    return()=>{active=false;};
  },[token]);
  return <div className="space-y-5 text-center"><h1 className="text-2xl font-bold text-ink">{state.busy?"正在验证邮箱…":state.error?"未能验证邮箱":"邮箱已验证"}</h1><p role={state.error?"alert":"status"} className="text-sm leading-6 text-muted">{state.error||(state.busy?"请稍候":"此邮箱现在可以用于找回密码。")}</p><Link href="/settings?sub=profile&anchor=profile" className="btn btn-line inline-flex min-h-[44px] items-center justify-center">返回设置</Link></div>;
}
