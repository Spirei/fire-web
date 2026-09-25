import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MODELS_DIR, SHOWROOM_DIR, readStoredModels, validModelId } from "@/lib/showcaseModels";

export const PROCESSING_DIR = path.join(SHOWROOM_DIR, "processing", "jobs");
export type ProcessingJob = { id: string; modelId: string; file: string; sourceBytes: number; sourceMtimeMs: number; status: "queued" | "running" | "done" | "failed" | "cancelled"; message: string; createdAt: string; updatedAt: string; preview?: boolean; gpu?: boolean };
const validJobId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

export function listProcessingJobs(): ProcessingJob[] {
  try {
    return fs.readdirSync(PROCESSING_DIR).filter(validJobId).flatMap(id => {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(PROCESSING_DIR, id, "job.json"), "utf8")) as ProcessingJob;
        return job.id === id ? [job] : [];
      } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { return []; }
}

export function queueModelProcessing(modelId: string): ProcessingJob {
  if (!validModelId(modelId)) throw new Error("车型不存在");
  const model = readStoredModels().find(item => item.id === modelId);
  if (!model) throw new Error("请先保存导入车型");
  const source = path.join(MODELS_DIR, model.file);
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size < 28 || stat.size > 250 * 1024 * 1024) throw new Error("原件缺失或超过 250 MiB");
  const space = fs.statfsSync(SHOWROOM_DIR);
  if (space.bavail * space.bsize < 2 * 1024 * 1024 * 1024) throw new Error("uploads 卷剩余空间不足 2 GiB，请先释放空间");
  const jobs = listProcessingJobs();
  const active = jobs.find(job => job.modelId === modelId && ["queued", "running"].includes(job.status));
  if (active) return active;
  if (jobs.filter(job => ["queued", "running"].includes(job.status)).length >= 3) throw new Error("群晖队列已满，请稍后重试");
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: ProcessingJob = { id, modelId, file: model.file, sourceBytes: stat.size, sourceMtimeMs: stat.mtimeMs, status: "queued", message: "等待群晖处理服务", createdAt: now, updatedAt: now };
  const directory = path.join(PROCESSING_DIR, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify(job), { flag: "wx" });
  return job;
}

export function cancelModelProcessing(jobId: string) {
  if (!validJobId(jobId)) throw new Error("任务不存在");
  const job = listProcessingJobs().find(item => item.id === jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status === "queued") {
    const directory = path.join(PROCESSING_DIR, jobId);
    const temporary = path.join(directory, `job.${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ ...job, status: "cancelled", message: "已取消", updatedAt: new Date().toISOString() }));
    fs.renameSync(temporary, path.join(directory, "job.json"));
  } else if (job.status === "running") fs.writeFileSync(path.join(PROCESSING_DIR, jobId, "cancel"), "1", { flag: "w" });
  return job;
}
