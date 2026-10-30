import type Database from 'better-sqlite3';
import { RecordsError } from './recordsContract';
import { postgresHandle } from './postgresDatabase';
const contexts=new WeakMap<Database.Database,ReadonlySet<string>>();
export function withTradeCorrection<T>(db:Database.Database,ids:ReadonlySet<string>,run:()=>T):T{const old=contexts.get(db);contexts.set(db,ids);postgresHandle(db)?.setGuardContext('tradeCorrection',ids);try{return run();}finally{postgresHandle(db)?.setGuardContext('tradeCorrection',old);if(old)contexts.set(db,old);else contexts.delete(db);}}
export function registerTradeCorrection(db:Database.Database){db.function('trade_correction_allowed',(id:unknown)=>contexts.get(db)?.has(String(id))?1:0);db.function('trade_correction_conflict',()=>{throw new RecordsError('成交更正凭证不可由旧接口覆盖或删除',409,40903);});}
export function installTradeCorrections(db:Database.Database){registerTradeCorrection(db);db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS trade_fee_details(
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_json TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_fee_detail_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_json TEXT NOT NULL,detail_json TEXT NOT NULL,archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_correction_operations(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS trade_correction_originals(
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,replacement_id TEXT,original_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_correction_replacements(
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS trade_correction_preserve BEFORE UPDATE ON trade_orders
    WHEN trade_correction_allowed(OLD.id)=0 AND (EXISTS(SELECT 1 FROM trade_correction_originals WHERE order_id=OLD.id) OR EXISTS(SELECT 1 FROM trade_correction_replacements WHERE order_id=OLD.id) OR (OLD.status='filled' AND EXISTS(SELECT 1 FROM trade_fee_details WHERE order_id=OLD.id))) AND
      (NEW.user_id IS NOT OLD.user_id OR NEW.record_id IS NOT OLD.record_id OR NEW.market IS NOT OLD.market OR NEW.code IS NOT OLD.code OR
       NEW.side IS NOT OLD.side OR NEW.status IS NOT OLD.status OR NEW.qty IS NOT OLD.qty OR NEW.price IS NOT OLD.price OR NEW.fees IS NOT OLD.fees OR
       NEW.amount IS NOT OLD.amount OR NEW.traded_at IS NOT OLD.traded_at OR NEW.created_at IS NOT OLD.created_at OR NEW.settlement_currency IS NOT OLD.settlement_currency OR NEW.settlement_amount IS NOT OLD.settlement_amount)
    BEGIN SELECT trade_correction_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS trade_correction_delete BEFORE DELETE ON trade_orders
    WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND (EXISTS(SELECT 1 FROM trade_correction_originals WHERE order_id=OLD.id) OR EXISTS(SELECT 1 FROM trade_correction_replacements WHERE order_id=OLD.id) OR (OLD.status='filled' AND EXISTS(SELECT 1 FROM trade_fee_details WHERE order_id=OLD.id)))
    BEGIN SELECT trade_correction_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS trade_correction_replace BEFORE INSERT ON trade_orders
    WHEN EXISTS(SELECT 1 FROM trade_correction_originals WHERE order_id=NEW.id) OR EXISTS(SELECT 1 FROM trade_correction_replacements WHERE order_id=NEW.id) OR EXISTS(SELECT 1 FROM trade_fee_details WHERE order_id=NEW.id)
    BEGIN SELECT trade_correction_conflict(); END;
  `);
}).immediate();}
