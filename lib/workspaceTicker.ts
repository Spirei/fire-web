import type { TickerConfig } from "./types";
import { clientRequestId } from "./randomId";
import { platformRequest } from "./platformRequest";

/** A signed-in workspace uses its own licensed observations, never the anonymous
 * redistribution endpoint. This read does not create a source or collect data. */
export async function readWorkspaceTicker(config: TickerConfig, signal: AbortSignal) {
  await platformRequest("/api/fire/ticker/demand",{method:"POST",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:clientRequestId()})},10000);
  const data = await platformRequest<{items:{key:string;market:string;secid:string;price?:number;change?:number;changePct?:number;observedAt?:string;source?:string;session?:string;sourceRevision?:string;displayStale?:boolean;cached?:boolean}[]}>("/api/fire/ticker", {signal},10000);
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {items:config.items.map(item => {
    const quote = data.items?.find(observation => observation.key === item.key && observation.market === item.market && observation.secid === item.secid);
    const price = numeric(quote?.price);
    return {key:item.key,label:item.label,market:item.market,price:price !== null && price > 0 ? price : null,
      change:price !== null && price > 0 ? numeric(quote?.change) : null,
      changePct:price !== null && price > 0 ? numeric(quote?.changePct) : null,
      observedAt:quote?.observedAt,source:quote?.source,session:quote?.session,sourceRevision:quote?.sourceRevision,displayStale:quote?.displayStale,cached:quote?.cached,points:[] as number[]};
  }),interval:config.interval,pollSec:60};
}
