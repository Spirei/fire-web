import type { Celeb } from "./celebs";

const portraits = new Set(["buffett", "pelosi", "huang", "cathie", "trump", "duan"]);
export function celebPortrait(id: string) {
  const names:Record<string,string>={buffett:"buffett-custom-1785959604596-1b74c273.png",pelosi:"pelosi-custom-1786043465104-fed471cd.png",huang:"huang-custom-1785959912531-8b437268.png",cathie:"cathie-custom-1786043468667-6e835ac3.png",trump:"trump-custom-1786043526485-1e34c87e.png",duan:"duan-custom-1785959747574-b3c57b2d.png"};
  return portraits.has(id) ? `/uploads/celebs/${names[id]}` : "";
}
export function disclosedNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}
export function displayPercent(value: unknown, digits = 2) {
  const number = disclosedNumber(value);
  return number === null ? "—" : `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}
/** PG decimal strings and absent observations retain their meaning at the UI boundary. */
export function normalizeCelebDirectory(input: unknown): {celebs:Celeb[];detail:Record<string,unknown>;source:string} {
  if (!input || typeof input !== "object" || !Array.isArray((input as {celebs?:unknown}).celebs)) throw Error("名人持仓响应格式无效");
  const data = input as {celebs:Record<string,unknown>[];detail?:Record<string,unknown>;source?:string};
  const numeric = (item:Record<string,unknown>, keys:string[]) => Object.fromEntries(keys.map(key => [key,disclosedNumber(item[key])]));
  const list = data.celebs.map(person => {
    if (!person || typeof person.id !== "string" || typeof person.name !== "string" || !Array.isArray(person.holdings) || !Array.isArray(person.trades)) throw Error("名人持仓条目格式无效");
    return {...person, avatar:person.avatar || celebPortrait(person.id), gain250:disclosedNumber(person.gain250), updated:typeof person.updated === "string" ? person.updated : person.reportDate || "—",
      holdings:person.holdings.map(item => ({...item,...numeric(item,["weight","weightDelta","price","changePct","target","marketCap"])})),
      trades:person.trades.map(item => ({...item,changePct:disclosedNumber(item.changePct)})),
    } as unknown as Celeb;
  });
  return {celebs:list, detail:data.detail || {}, source:data.source || "stored_public_disclosures"};
}
