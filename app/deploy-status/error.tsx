"use client";

export default function DeployStatusError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="deploy-status-page flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4 text-slate-900 dark:bg-[#0b0f16] dark:text-slate-100">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
        <h1 className="text-base font-medium">发布状态暂时无法显示</h1>
        <p className="mt-2 text-sm text-slate-500">GitHub 数据刷新失败，页面没有丢失。</p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          重新加载
        </button>
      </div>
    </main>
  );
}
