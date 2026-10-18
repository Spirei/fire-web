import { createHash } from 'node:crypto';
import { getDb } from './db';
import { listRecords, parseMarket } from './store';
import { importIdentity } from './importIdentity';
import { holdingAccountMarket, stockAccountError } from './stockAccount';
import { RecordsError } from './recordsContract';
import type { StockRecord } from './types';

export interface BuyTarget { brokerAccountId: string; brokerRevision: number; market: StockRecord['market']; code: string; name: string; accountMarket?: string }
export function parseBuyTarget(value: unknown): BuyTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordsError('买入账户目标无效');
  const t = value as Record<string, unknown>;
  if (Object.keys(t).some(k => !['brokerAccountId','brokerRevision','market','code','name','accountMarket'].includes(k)) || typeof t.brokerAccountId !== 'string' || !/^ba-[a-f0-9]{24}$/.test(t.brokerAccountId) || !Number.isSafeInteger(t.brokerRevision) || Number(t.brokerRevision) < 1 || typeof t.market !== 'string' || parseMarket(t.market) !== t.market || typeof t.code !== 'string' || t.code.length > 40 || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 100 || t.accountMarket !== undefined && typeof t.accountMarket !== 'string') throw new RecordsError('买入账户或证券身份无效');
  if (stockAccountError(t.market,t.accountMarket)) throw new RecordsError('账户市场无效');
  let code: string;
  try { code = importIdentity(t.code,t.market).code; } catch { throw new RecordsError('证券市场与代码不一致'); }
  if (!code) throw new RecordsError('证券代码无效');
  return {brokerAccountId:t.brokerAccountId,brokerRevision:Number(t.brokerRevision),market:t.market as StockRecord['market'],code,name:t.name.trim(),accountMarket:t.market==='HK' && t.accountMarket==='CN' ? 'CN' : ''};
}
/** Read-only resolution. The caller owns the preview read / final IMMEDIATE transaction. */
export function resolveBuyTarget(userId: string, t: BuyTarget) {
  const account = getDb().prepare('SELECT name,revision,holding_source FROM broker_accounts WHERE user_id=? AND id=?').get(userId,t.brokerAccountId) as {name:string;revision:number;holding_source:string}|undefined;
  if (!account) throw new RecordsError('券商账户不存在',404);
  if (account.holding_source === 'official') throw new RecordsError('官方管理账户不能手动交易',409,40903);
  if (account.revision !== t.brokerRevision) throw new RecordsError('券商账户已变化，请重新预览',409,40902);
  const matches = listRecords(userId).filter(r => r.brokerAccountId === t.brokerAccountId && r.market === t.market && holdingAccountMarket(r) === holdingAccountMarket(t) && (importIdentity(r.code,r.market).code || r.code.trim().toUpperCase()) === t.code);
  if (matches.length > 1) throw new RecordsError('同一账户存在重复证券，请先核对持仓',409,40902);
  const existing = matches[0];
  const record: StockRecord = existing ?? {id:'',name:t.name,code:t.code,market:t.market,accountMarket:t.accountMarket,brokerAccountId:t.brokerAccountId,group:account.name,qty:0,cost:0,price:0,note:'',updatedAt:'',revision:0};
  const target = {...t,name:record.name,brokerName:account.name,recordId:existing?.id ?? null,recordRevision:existing?.revision ?? null,createsRecord:!existing};
  const targetRevision = createHash('sha256').update(JSON.stringify(target)).digest('hex');
  return {record,target:{...target,targetRevision}};
}
