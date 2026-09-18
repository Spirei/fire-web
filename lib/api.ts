/* ---------- 统一 API 响应规范（全站 / 移动端 Swift·Android 通用） ----------
 *
 * 成功：{ code: 0, message: "ok", data: <资源> }
 * 分页：{ code: 0, message: "ok", data: <数组>, meta: { page, pageSize, total } }
 * 失败：{ code: <业务错误码>, message: "<错误信息>" } + 对应 HTTP 状态码
 *
 * 错误码分段：
 *   0         成功
 *   40000-499 请求参数（40001 参数无效 / 40002 请求体无效 / 40003 校验失败）
 *   40100-199 认证（40101 未登录 / 40102 会话失效 / 40103 用户名或密码错误 / 40104 二次验证失败）
 *   40300-399 权限（40301 无权限）
 *   40400-499 资源（40401 资源不存在）
 *   40900-999 冲突（40901 重复 / 40902 状态冲突）
 *   42900-999 限流（42901 请求过于频繁）
 *   50000-599 服务器（50001 内部错误 / 50002 上游数据源失败）
 */
import { NextResponse } from "next/server";

export const API_CODE = {
  OK: 0,
  BAD_PARAM: 40001,
  BAD_BODY: 40002,
  VALIDATION: 40003,
  UNAUTHORIZED: 40101,
  SESSION_EXPIRED: 40102,
  BAD_CREDENTIALS: 40103,
  TOTP_FAILED: 40104,
  FORBIDDEN: 40301,
  NOT_FOUND: 40401,
  CONFLICT: 40901,
  RATE_LIMIT: 42901,
  INTERNAL: 50001,
  UPSTREAM: 50002
} as const;

export interface ApiMeta {
  page: number;
  pageSize: number;
  total: number;
  [k: string]: unknown;
}

/** 成功响应（统一信封） */
export function ok<T>(data: T, meta?: ApiMeta) {
  return NextResponse.json(
    meta ? { code: API_CODE.OK, message: "ok", data, meta } : { code: API_CODE.OK, message: "ok", data }
  );
}

/** 失败响应（统一错误信封 + HTTP 状态码） */
export function fail(code: number, message: string, status = 400) {
  return NextResponse.json({ code, message }, { status });
}

/** 从请求里读取统一分页参数（page 从 1 开始，pageSize 默认 20、上限 100） */
export function parsePage(searchParams: URLSearchParams, defaultSize = 20, maxSize = 100) {
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(searchParams.get("pageSize")) || defaultSize));
  return { page, pageSize };
}

/** 构造分页 meta */
export function pageMeta(page: number, pageSize: number, total: number): ApiMeta {
  return { page, pageSize, total };
}
