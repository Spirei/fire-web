"use client";

export async function passkeyRequest(body: unknown, method = "POST", url = "/api/auth/passkeys") {
  const response = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "请求失败，请稍后重试");
  return data;
}
export function passkeyError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return "操作已取消或超时，可重新尝试";
    if (error.name === "InvalidStateError") return "此密码管理器中已有该账号的通行密钥，请选择其他保存位置";
    if (error.name === "SecurityError") return "请通过管理员配置的 HTTPS 站点地址使用通行密钥";
    if (/[\u4e00-\u9fff]/.test(error.message)) return error.message;
  }
  return "通行密钥操作未完成，请重试或使用密码登录";
}
