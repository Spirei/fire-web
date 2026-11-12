"use client";
import { clientRequestId } from "./randomId";
import { platformRequest } from "./platformRequest";
import { accountReadHeaders } from "./privateReadContext";

/** Explicit view intent; all consumers use the same PG streams and Worker. */
export async function prepareMarketHistory(items: {market:string;code:string}[], options: {days?:number;adjust?:string;index?:boolean;ownerId?:string;signal?:AbortSignal} = {}) {
  return platformRequest("/api/kline/prepare",{method:"POST",signal:options.signal,headers:{"Content-Type":"application/json",...accountReadHeaders(options.ownerId)},body:JSON.stringify({requestId:clientRequestId(),items,days:options.days ?? 330,adjust:options.adjust ?? "none",index:options.index === true})},20000);
}
