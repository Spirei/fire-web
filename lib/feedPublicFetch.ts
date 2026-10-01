import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as publicFetch } from "undici";
import { isPrivateHost } from "./net";
import { readLimitedResponseBytes,readLimitedResponseJson } from "./requestBody";

export function publicFeedUrl(value: unknown): string | null {
  if(typeof value!=="string"||value.length>2048)return null;
  try {const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==="443")&&!isPrivateHost(u.hostname)&&u.hostname.includes(".")&&![...u.searchParams.keys()].some(k=>/^(?:token|key|api_key|password|auth|secret|email)$/i.test(k))?u.href:null;}catch{return null;}
}
export function publicFeedAddresses(rows: Array<{address:string;family:number}>) {
  if(!rows.length||rows.length>16||rows.some(r=>isIP(r.address)!==r.family||isPrivateHost(r.address)||(r.family===4&&(Number(r.address.split(".")[0])>=224||/^(?:192\.0\.|192\.0\.2\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|168\.63\.129\.16$)/.test(r.address)))||(r.family===6&&(!/^[23][\da-f]{3}:/i.test(r.address)||/^2001:db8:/i.test(r.address)))))throw new Error("feed_private_address");
  return rows[0];
}
async function publicAddress(host:string,signal:AbortSignal) {
  const rows=await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{if(signal.aborted)reject(new Error("feed_timeout"));else signal.addEventListener("abort",()=>reject(new Error("feed_timeout")),{once:true});})]);
  // Clash-style fake-IP is a routing placeholder, not a verified public destination.
  // Resolve only this specific all-fake-IP case through a fixed public DoH endpoint,
  // then apply the same private-address checks and connection pinning. Other private DNS fails.
  if(rows.length&&rows.every(r=>r.family===4&&/^198\.1[89]\./.test(r.address))){
    const url=new URL("https://cloudflare-dns.com/dns-query");url.search=new URLSearchParams({name:host,type:"A"}).toString();
    const response=await fetch(url,{headers:{Accept:"application/dns-json"},redirect:"error",signal,cache:"no-store"});if(!response.ok)throw new Error("feed_dns_unavailable");
    const data=await readLimitedResponseJson<{Answer?:Array<{type:number;data:string}>}>(response,16_000);
    return publicFeedAddresses((data?.Answer||[]).filter(r=>r.type===1).map(r=>({address:r.data,family:4})));
  }
  return publicFeedAddresses(rows);
}
/** User-selected public feeds: DNS checked AND pinned at connection time, every redirect checked.
 * Never use ambient credentials or the proxy (which would perform its own unpinned DNS).
 */
export async function fetchPublicFeedDocument(raw:string) {
  let url=publicFeedUrl(raw);if(!url)throw new Error("feed_invalid_url");
  const signal=AbortSignal.timeout(12_000);
  for(let hop=0;hop<3;hop++) {
    const u=new URL(url),address=await publicAddress(u.hostname,signal);
    const dispatcher=new Agent({autoSelectFamily:false,connect:{lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)}});
    try {
      const r=await publicFetch(url,{dispatcher,redirect:"manual",signal,headers:{Accept:"application/rss+xml, application/atom+xml, application/xml, text/xml, text/html", "User-Agent":"AlcorFeedReader/1.0"}});
      if([301,302,303,307,308].includes(r.status)) {
        const next=r.headers.get("location");await r.body?.cancel();url=next?publicFeedUrl(new URL(next,url).href):null;if(!url)throw new Error("feed_invalid_redirect");continue;
      }
      if(!r.ok)throw new Error("feed_http_"+r.status);
      const type=r.headers.get("content-type")||"";
      if(!/(?:xml|html|text\/plain)/i.test(type)){await r.body?.cancel();throw new Error("feed_invalid_content");}
      return {url,text:new TextDecoder().decode(await readLimitedResponseBytes(r as unknown as Response,1_500_000)),contentType:type};
    } finally {await dispatcher.close();}
  }
  throw new Error("feed_redirect_limit");
}
