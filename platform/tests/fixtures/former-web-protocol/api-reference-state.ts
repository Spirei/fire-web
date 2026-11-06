export type Reference = {
  version: 1 | 2;
  content: string | null;
  revision: string | null;
};
export type ReferenceReceipt = {
  requestId: string;
  state: "completed" | "failed" | "closed";
  status: number;
  revision?: string;
  message?: string;
};
export function referenceReceipt(value: unknown, id: string): ReferenceReceipt {
  if (!value || typeof value !== "object") throw new Error("文档回执无效");
  const row = value as ReferenceReceipt;
  if (
    row.requestId !== id ||
    !["completed", "failed", "closed"].includes(row.state) ||
    !Number.isInteger(row.status)
  )
    throw new Error("文档回执无效");
  if (
    row.state === "completed" &&
    (row.status !== 200 || !/^[a-f0-9]{64}$/.test(row.revision || ""))
  )
    throw new Error("文档回执无效");
  return row;
}
export function retainReferenceOperation(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  id: string,
) {
  const prior = storage.getItem(key);
  if (prior && prior !== id) throw new Error("请先查询原文档操作");
  storage.setItem(key, id);
  if (storage.getItem(key) !== id) throw new Error("无法保存原操作编号");
}
