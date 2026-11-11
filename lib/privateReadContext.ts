import type { StockRecord } from "./types";
import { quoteInstrumentKey } from "./quoteBatches";

export const PRIVATE_READ_EVENTS = ["fire:records-updated", "fire:settings-updated"] as const;
let epoch = 0;
if (typeof window !== "undefined") for (const event of PRIVATE_READ_EVENTS) window.addEventListener(event, (value) => { if(event==="fire:settings-updated" && (value as CustomEvent).detail?.dataChanged===false)return;epoch++; });
export const privateReadEpoch = () => epoch;
export const retirePrivateReadContext = () => { epoch++; };
export const accountReadHeaders = (ownerId?: string): Record<string,string> => ownerId ? { "X-Alcor-Expected-Account": ownerId } : {};

/** IDs are opaque; a stable row ID does not mean the instrument or ledger stayed the same. */
export function recordsReadSignature(records: StockRecord[]) {
  return JSON.stringify(records.map(record => [quoteInstrumentKey(record), record.qty, record.cost, record.revision, record.updatedAt]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
}
