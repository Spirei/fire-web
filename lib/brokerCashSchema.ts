import type Database from 'better-sqlite3';
import { RecordsError } from './recordsContract';
export function registerBrokerCashGuard(db: Database.Database) {
  db.function('broker_cash_conflict',()=>{throw new RecordsError('券商资金已有覆盖记录，请核对资金账本后操作',409,40902);});
}
export function installBrokerCash(db: Database.Database) {
  registerBrokerCashGuard(db);
  db.exec(`CREATE TABLE IF NOT EXISTS broker_cash_accounts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,revision INTEGER NOT NULL,opening_amount REAL NOT NULL,opening_at TEXT NOT NULL,
    opening_basis TEXT NOT NULL,PRIMARY KEY(user_id,account_id,currency));
    CREATE TABLE IF NOT EXISTS broker_cash_entries (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,kind TEXT NOT NULL,amount REAL NOT NULL,direction INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,created_at TEXT NOT NULL,note TEXT NOT NULL,operation_id TEXT NOT NULL,
    fund_id TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS broker_cash_entries_owner ON broker_cash_entries(user_id,account_id,currency);
    CREATE TABLE IF NOT EXISTS broker_cash_order_links (
    order_id TEXT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,currency TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS broker_cash_links_owner ON broker_cash_order_links(user_id,account_id,currency);
  `);
  // Stable cash ownership is assigned once at order creation, never from today's record name/owner.
  const currency = `(CASE WHEN NEW.settlement_currency IS NOT NULL AND NEW.settlement_currency<>'' THEN NEW.settlement_currency ELSE CASE NEW.market WHEN 'HK' THEN 'HKD' WHEN 'CN' THEN 'CNY' WHEN 'JP' THEN 'JPY' WHEN 'KR' THEN 'KRW' WHEN 'SG' THEN 'SGD' WHEN 'EU' THEN 'EUR' ELSE 'USD' END END)`;
  const oldCurrency=currency.replaceAll('NEW.','OLD.');
  const oldCovered=`EXISTS(SELECT 1 FROM broker_cash_accounts c WHERE c.user_id=OLD.user_id AND c.currency=${oldCurrency} AND c.opening_basis='allocate_verified_unallocated_checkpoint' AND julianday(OLD.traded_at)<=julianday(c.opening_at))`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_fund_insert BEFORE INSERT ON fund_transactions
    WHEN NEW.id NOT LIKE 'fund-order-%' AND EXISTS(SELECT 1 FROM broker_cash_accounts c WHERE c.user_id=NEW.user_id AND c.currency=NEW.currency AND c.opening_basis='allocate_verified_unallocated_checkpoint' AND (julianday(NEW.occurred_at) IS NULL OR julianday(NEW.occurred_at)<julianday(c.opening_at)))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_fund_update BEFORE UPDATE ON fund_transactions
    WHEN OLD.id NOT LIKE 'fund-order-%' AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM broker_cash_accounts c WHERE c.user_id=OLD.user_id AND c.currency=OLD.currency AND c.opening_basis='allocate_verified_unallocated_checkpoint' AND julianday(OLD.occurred_at)<=julianday(c.opening_at))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_fund_delete BEFORE DELETE ON fund_transactions
    WHEN OLD.id NOT LIKE 'fund-order-%' AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM broker_cash_accounts c WHERE c.user_id=OLD.user_id AND c.currency=OLD.currency AND c.opening_basis='allocate_verified_unallocated_checkpoint' AND julianday(OLD.occurred_at)<=julianday(c.opening_at))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_order_insert BEFORE INSERT ON trade_orders
    WHEN EXISTS(SELECT 1 FROM broker_cash_accounts c WHERE c.user_id=NEW.user_id AND c.currency=${currency} AND c.opening_basis='allocate_verified_unallocated_checkpoint' AND (julianday(NEW.traded_at) IS NULL OR julianday(NEW.traded_at)<julianday(c.opening_at)))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_order_delete BEFORE DELETE ON trade_orders
    WHEN OLD.status='filled' AND ${oldCovered} AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_checkpoint_order_update BEFORE UPDATE ON trade_orders
    WHEN OLD.status='filled' AND ${oldCovered} AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
      AND (NEW.status IS NOT OLD.status OR NEW.qty IS NOT OLD.qty OR NEW.price IS NOT OLD.price OR NEW.fees IS NOT OLD.fees OR NEW.amount IS NOT OLD.amount OR NEW.side IS NOT OLD.side OR NEW.market IS NOT OLD.market OR NEW.settlement_currency IS NOT OLD.settlement_currency OR NEW.settlement_amount IS NOT OLD.settlement_amount OR NEW.traded_at IS NOT OLD.traded_at)
    BEGIN SELECT broker_cash_conflict(); END;
  `);
  db.exec(`CREATE TRIGGER IF NOT EXISTS broker_cash_account_delete BEFORE DELETE ON broker_accounts
    WHEN EXISTS(SELECT 1 FROM broker_cash_accounts WHERE account_id=OLD.id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_order_replace BEFORE INSERT ON trade_orders
    WHEN EXISTS(SELECT 1 FROM broker_cash_order_links WHERE order_id=NEW.id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_pending_identity BEFORE UPDATE ON trade_orders
    WHEN EXISTS(SELECT 1 FROM broker_cash_order_links WHERE order_id=OLD.id) AND
      (NEW.user_id IS NOT OLD.user_id OR NEW.record_id IS NOT OLD.record_id OR NEW.market IS NOT OLD.market OR NEW.settlement_currency IS NOT OLD.settlement_currency OR
      EXISTS(SELECT 1 FROM broker_cash_order_links l JOIN broker_cash_accounts c ON c.user_id=l.user_id AND c.account_id=l.account_id AND c.currency=l.currency WHERE l.order_id=OLD.id AND julianday(NEW.traded_at)<julianday(c.opening_at)))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_fund_replace BEFORE INSERT ON fund_transactions
    WHEN EXISTS(SELECT 1 FROM broker_cash_entries WHERE fund_id=NEW.id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_order_time BEFORE INSERT ON trade_orders
    WHEN EXISTS(SELECT 1 FROM records r JOIN broker_cash_accounts c ON c.user_id=r.user_id AND c.account_id=r.broker_account_id
      WHERE r.id=NEW.record_id AND r.user_id=NEW.user_id AND c.currency=${currency} AND julianday(NEW.traded_at)<julianday(c.opening_at))
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_order_link AFTER INSERT ON trade_orders BEGIN
      INSERT INTO broker_cash_order_links(order_id,user_id,account_id,currency)
      SELECT NEW.id,NEW.user_id,c.account_id,c.currency FROM records r JOIN broker_cash_accounts c ON c.user_id=r.user_id AND c.account_id=r.broker_account_id
      WHERE r.id=NEW.record_id AND r.user_id=NEW.user_id AND c.currency=${currency};
      UPDATE broker_cash_accounts SET revision=revision+1 WHERE (user_id,account_id,currency) IN(SELECT user_id,account_id,currency FROM broker_cash_order_links WHERE order_id=NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_filled_update BEFORE UPDATE ON trade_orders
    WHEN OLD.status='filled' AND EXISTS(SELECT 1 FROM broker_cash_order_links WHERE order_id=OLD.id)
      AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
      AND (NEW.status IS NOT OLD.status OR NEW.qty IS NOT OLD.qty OR NEW.price IS NOT OLD.price OR NEW.fees IS NOT OLD.fees OR NEW.amount IS NOT OLD.amount OR NEW.side IS NOT OLD.side OR NEW.market IS NOT OLD.market OR NEW.record_id IS NOT OLD.record_id OR NEW.settlement_currency IS NOT OLD.settlement_currency OR NEW.settlement_amount IS NOT OLD.settlement_amount OR NEW.traded_at IS NOT OLD.traded_at)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_order_update AFTER UPDATE ON trade_orders BEGIN
      UPDATE broker_cash_accounts SET revision=revision+1 WHERE (user_id,account_id,currency) IN(SELECT user_id,account_id,currency FROM broker_cash_order_links WHERE order_id=NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_filled_delete BEFORE DELETE ON trade_orders
    WHEN OLD.status='filled' AND EXISTS(SELECT 1 FROM broker_cash_order_links WHERE order_id=OLD.id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_pending_delete BEFORE DELETE ON trade_orders BEGIN
      UPDATE broker_cash_accounts SET revision=revision+1 WHERE (user_id,account_id,currency) IN(SELECT user_id,account_id,currency FROM broker_cash_order_links WHERE order_id=OLD.id);
    END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_fund_delete BEFORE DELETE ON fund_transactions
    WHEN EXISTS(SELECT 1 FROM broker_cash_entries WHERE fund_id=OLD.id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
    CREATE TRIGGER IF NOT EXISTS broker_cash_fund_update BEFORE UPDATE ON fund_transactions
    WHEN EXISTS(SELECT 1 FROM broker_cash_entries WHERE fund_id=OLD.id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
    BEGIN SELECT broker_cash_conflict(); END;
  `);
}
