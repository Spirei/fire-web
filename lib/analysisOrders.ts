import type { TradeOrder } from "./types";
import { accountReadHeaders } from "./privateReadContext";
import { platformRequest } from "./platformRequest";

/** v1 keeps its response envelope; an invalid read is never an empty history. */
export async function readAnalysisOrders(ownerId: string, signal?: AbortSignal): Promise<TradeOrder[]> {
  const result = await platformRequest<{code:number;data?:{orders:TradeOrder[]}}>("/api/v1/orders?scope=all&limit=5000", {
    signal, headers: accountReadHeaders(ownerId)
  }, 20000);
  if (result?.code !== 0 || !Array.isArray(result.data?.orders)) throw new Error("历史订单格式无效");
  return result.data.orders;
}
