import type { Metadata } from "next";
import EmailRecoveryForm from "@/components/EmailRecoveryForm";

export const metadata: Metadata = { title: "重置密码 - Alcor" };

export default function ResetPasswordPage() {
  return <main className="flex min-h-screen items-center justify-center bg-bg-gray/70 px-4 py-10 dark:bg-[#0a0e19]">
    <section className="w-full max-w-[440px] rounded-[20px] border border-edge bg-white p-7 shadow-[0_24px_60px_rgba(10,14,25,.12)] dark:border-[#2a3140] dark:bg-[#12161f] sm:p-10">
      <EmailRecoveryForm />
    </section>
  </main>;
}
