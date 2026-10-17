import type Database from 'better-sqlite3';
import { RecordsError } from './recordsContract';

export function registerBrokerSourceGuard(db:Database.Database){
  db.function('broker_source_conflict',()=>{throw new RecordsError('该账户由官方账单管理，请切回手动后再修改持仓',409,40903);});
}

/** Every SQL writer (including legacy imports/replays) obeys the same source gate. */
export function installBrokerHoldingSource(db:Database.Database){
  const columns=db.prepare('PRAGMA table_info(broker_accounts)').all() as {name:string}[];
  if(!columns.some(c=>c.name==='holding_source'))db.exec("ALTER TABLE broker_accounts ADD COLUMN holding_source TEXT NOT NULL DEFAULT 'manual' CHECK(holding_source IN ('manual','official'))");
  db.exec(`CREATE TABLE IF NOT EXISTS broker_official_write_context (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,account_id));`);
  registerBrokerSourceGuard(db);
  const blocked=(r:string)=>`EXISTS(SELECT 1 FROM broker_accounts b WHERE b.user_id=${r}.user_id
    AND (b.id=${r}.broker_account_id OR (${r}.broker_account_id='' AND b.name=${r}.group_name))
    AND b.holding_source='official' AND NOT EXISTS(SELECT 1 FROM broker_official_write_context c WHERE c.user_id=b.user_id AND c.account_id=b.id))`;
  const identity=['user_id','code','market','account_market','price','cost','qty','broker_account_id'];
  const financialChange=identity.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ');
  // Renaming a broker keeps its stable ID and may update the display-only group label.
  const regroup=`(NEW.group_name IS NOT OLD.group_name AND NOT (NEW.broker_account_id!='' AND NEW.broker_account_id=OLD.broker_account_id AND EXISTS(SELECT 1 FROM broker_accounts b WHERE b.user_id=NEW.user_id AND b.id=NEW.broker_account_id AND b.name=NEW.group_name)))`;
  db.exec(`
    DROP TRIGGER IF EXISTS broker_source_record_insert;
    DROP TRIGGER IF EXISTS broker_source_record_update;
    DROP TRIGGER IF EXISTS broker_source_record_delete;
    CREATE TRIGGER broker_source_record_insert BEFORE INSERT ON records
      WHEN ${blocked('NEW')} OR EXISTS(SELECT 1 FROM records r WHERE r.id=NEW.id AND ${blocked('r')}) BEGIN SELECT broker_source_conflict(); END;
    CREATE TRIGGER broker_source_record_update BEFORE UPDATE ON records
      WHEN (${financialChange} OR ${regroup}) AND (${blocked('OLD')} OR ${blocked('NEW')})
      BEGIN SELECT broker_source_conflict(); END;
    CREATE TRIGGER broker_source_record_delete BEFORE DELETE ON records
      WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND ${blocked('OLD')}
      BEGIN SELECT broker_source_conflict(); END;
  `);
  // Order edits/imports can alter cash/history without touching a position (e.g. dividends).
  for(const action of ['INSERT','UPDATE','DELETE']){
    const refs=action==='INSERT'?['NEW']:action==='DELETE'?['OLD']:['OLD','NEW'];
    const guarded=refs.map(ref=>`EXISTS(SELECT 1 FROM records r WHERE r.id=${ref}.record_id AND r.user_id=${ref}.user_id AND ${blocked('r')})`).join(' OR ')+(action==='INSERT'?` OR EXISTS(SELECT 1 FROM trade_orders original JOIN records r ON r.id=original.record_id AND r.user_id=original.user_id WHERE original.id=NEW.id AND ${blocked('r')})`:'');
    db.exec(`DROP TRIGGER IF EXISTS broker_source_order_${action.toLowerCase()};
      CREATE TRIGGER broker_source_order_${action.toLowerCase()} BEFORE ${action} ON trade_orders
      WHEN EXISTS(SELECT 1 FROM users WHERE id=${refs[0]}.user_id) AND (${guarded}) BEGIN SELECT broker_source_conflict(); END;`);
  }
}
