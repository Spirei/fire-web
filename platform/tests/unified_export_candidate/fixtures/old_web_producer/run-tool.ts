export function runTool(command: string, args: string[], env: Record<string, string | undefined>) {
  const child = spawn(command, args, { env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(30 * 60_000) });
  let stderr = false;
  child.stderr.on("data", () => { stderr = true; }); // Drain but never persist database diagnostics/credentials.
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new MigrationExportError("export_tool_unavailable", "迁移导出工具不可用")));
    child.once("close", code => code === 0 && !stderr ? resolve() : reject(new MigrationExportError("export_tool_failed", "导出工具报告错误或警告；未发布不完整导出")));
  });
  void done.catch(() => {});
  return { child, done };
}