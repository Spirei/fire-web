/** Defaults retain existing deployments until an operator explicitly switches both processes. */
export function backgroundMode(value = process.env.FIRE_BACKGROUND_MODE): "embedded" | "external" | "off" {
  const mode = value || "embedded";
  if (mode !== "embedded" && mode !== "external" && mode !== "off") throw Error("后台运行模式无效");
  return mode;
}
export function verifyWorkerIdentity(actual: string | undefined, expected: string | undefined) {
  if (!expected || !actual || actual !== expected) throw Error("后台任务数据库标识未核对，拒绝启动");
}
