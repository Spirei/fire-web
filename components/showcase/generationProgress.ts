export type GenerationProgress = {
  status?: string; phase?: string; model?: string; error?: string;
  count?: number; total?: number; gpuCount?: number; gpuReused?: number; reused?: number;
  fileBytes?: number; textureBytes?: number; textureCount?: number; needsGpu?: boolean; startedAt?: number;
};
const memory = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function generationDetail(result: GenerationProgress, now = Date.now()) {
  const phase = ({ scan: "检测文件与贴图", preview: "生成首页预览", gpu: "生成保留源尺寸的 GPU 副本", complete: "处理完成", done: "处理完成", error: "处理失败" } as Record<string, string>)[result.phase ?? ""] ?? "处理中";
  const details = [`${result.model ? `${result.model} · ` : ""}${phase}`];
  if (typeof result.fileBytes === "number") details.push(`文件 ${memory(result.fileBytes)}`);
  if (typeof result.textureBytes === "number") details.push(`贴图展开约 ${memory(result.textureBytes)}`);
  if (result.startedAt) details.push(`已用时 ${Math.max(0, Math.floor((now - result.startedAt) / 1000))} 秒`);
  return details.join(" · ");
}
/** Retry read-only status queries only; never repeat the POST that starts encoding. */
export async function readGenerationStatus(jobId: string, onRetry: (attempt: number) => void, {
  fetcher = fetch,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
} = {}): Promise<GenerationProgress> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetcher(`/api/showcase/models/previews?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (response.status >= 500) throw new Error("暂时无法查询");
      const result = await response.json();
      if (!response.ok) return { status: "error", error: result.error ?? "无法读取任务状态" };
      if (!result || !["idle", "running", "done", "error"].includes(result.status)) throw new Error("任务状态无效");
      return result;
    } catch {
      if (attempt === 4) throw new Error("暂时无法查询进度，后台任务可能仍在运行，请稍后查看");
      onRetry(attempt + 1);
      await wait(Math.min(1000 * 2 ** attempt, 8000));
    }
  }
  throw new Error("无法读取任务状态");
}
