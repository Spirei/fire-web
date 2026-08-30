import { randomBytes } from "crypto";

/**
 * 生成 10 位唯一订单号（随机数，DB 唯一索引兜底，碰撞时由调用方重试）。
 * 订单量级不大，10 位空间（1e10）足够；后续量级变大再换更长的方案。
 */
export function generateOrderNo(): string {
  const rand = Number(`0x${randomBytes(4).toString("hex")}`) % 10_000_000_000;
  return String(rand).padStart(10, "0");
}
