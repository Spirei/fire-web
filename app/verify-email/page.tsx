import type { Metadata } from "next";
import EmailVerificationResult from "@/components/EmailVerificationResult";
export const metadata:Metadata={title:"确认邮箱 - Fire",referrer:"no-referrer",robots:{index:false,follow:false}};
export default async function VerifyEmailPage({searchParams}:{searchParams:Promise<{token?:string}>}) {
  const {token=""}=await searchParams;
  return <main className="flex min-h-screen items-center justify-center bg-bg-gray px-4 py-10"><section className="w-full max-w-[440px] rounded-[20px] border border-edge bg-white p-7 sm:p-10"><EmailVerificationResult key={token} token={token}/></section></main>;
}
