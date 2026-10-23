import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';

/** An import fingerprint is evidence of this exact input, never of an account name. */
export function feeInputFingerprint(row: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(['user_id','record_id','market','code','side','status','qty','price','amount','traded_at'].map(k=>row[k]))).digest('hex');
}
export function installHistoricalFees(db: Database.Database) {
  db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS trade_fee_preview_key (id INTEGER PRIMARY KEY CHECK(id=1),secret BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_fee_evidence (
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,input_hash TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_fee_corrections (
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,source TEXT NOT NULL,old_fees REAL NOT NULL,new_fees REAL NOT NULL,
    detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
    DROP TRIGGER IF EXISTS trade_fee_explicit_input;
    DROP TRIGGER IF EXISTS trade_fee_explicit_confirmation;
    DROP TRIGGER IF EXISTS trade_fee_corrected_preserve;
    DROP TRIGGER IF EXISTS trade_fee_corrected_delete;
    DROP TRIGGER IF EXISTS trade_fee_corrected_replace;
    CREATE TRIGGER IF NOT EXISTS trade_fee_explicit_input AFTER INSERT ON trade_orders BEGIN
      INSERT INTO trade_fee_evidence VALUES(NEW.id,NEW.user_id,'explicit_order_entry','',
        json_object('brokerAccountId',(SELECT broker_account_id FROM records WHERE id=NEW.record_id AND user_id=NEW.user_id)),NEW.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS trade_fee_explicit_confirmation AFTER UPDATE OF fees ON trade_orders
    WHEN broker_cash_fee_correction(NEW.id)=0 BEGIN
      INSERT INTO trade_fee_evidence VALUES(NEW.id,NEW.user_id,'explicit_fee_confirmation','', '{}',NEW.created_at)
      ON CONFLICT(order_id) DO UPDATE SET source='explicit_fee_confirmation';
    END;
    CREATE TRIGGER IF NOT EXISTS trade_fee_corrected_preserve BEFORE UPDATE ON trade_orders
    WHEN trade_correction_allowed(OLD.id)=0 AND EXISTS(SELECT 1 FROM trade_fee_corrections WHERE order_id=OLD.id) AND
      (NEW.user_id IS NOT OLD.user_id OR NEW.record_id IS NOT OLD.record_id OR NEW.market IS NOT OLD.market OR NEW.code IS NOT OLD.code OR
       NEW.side IS NOT OLD.side OR NEW.status IS NOT OLD.status OR NEW.qty IS NOT OLD.qty OR NEW.price IS NOT OLD.price OR
       NEW.fees IS NOT OLD.fees OR NEW.amount IS NOT OLD.amount OR NEW.traded_at IS NOT OLD.traded_at OR NEW.created_at IS NOT OLD.created_at OR
       NEW.settlement_currency IS NOT OLD.settlement_currency OR NEW.settlement_amount IS NOT OLD.settlement_amount)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS trade_fee_corrected_delete BEFORE DELETE ON trade_orders
    WHEN EXISTS(SELECT 1 FROM trade_fee_corrections WHERE order_id=OLD.id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS trade_fee_corrected_replace BEFORE INSERT ON trade_orders
    WHEN EXISTS(SELECT 1 FROM trade_fee_corrections WHERE order_id=NEW.id)
    BEGIN SELECT broker_cash_conflict(); END;
  `);
  db.prepare('INSERT OR IGNORE INTO trade_fee_preview_key VALUES(1,?)').run(randomBytes(32));
  }).immediate();
}
