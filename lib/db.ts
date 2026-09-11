import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { hashPassword, validatePassword } from "./password";
import type { RecordInput } from "./types";
import { maybeRunBackup } from "./backup";
import { applyFilledTrade } from "./tradeAccounting";
import { generateOrderNo } from "./orderNo";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "fire.db");

let db: Database.Database | null = null;

const SEED_RECORDS: RecordInput[] = [
  { name: "腾讯控股", code: "00700", market: "HK", price: 475.2, cost: 380, qty: 200, group: "核心持仓", note: "游戏 + 广告复苏，目标 500" },
  { name: "阿里巴巴", code: "09988", market: "HK", price: 92.5, cost: 105, qty: 500, group: "核心持仓", note: "关注回购与云业务拆分" },
  { name: "Apple", code: "AAPL", market: "US", price: 308.91, cost: 190, qty: 50, group: "科技", note: "估值合理，长期持有" },
  { name: "NVIDIA", code: "NVDA", market: "US", price: 171.4, cost: 120, qty: 100, group: "科技", note: "AI 算力主线" },
  { name: "贵州茅台", code: "600519", market: "CN", price: 1350.6, cost: 1500, qty: 10, group: "消费", note: "观察中，等回调" },
  { name: "五粮液", code: "000858", market: "CN", price: 78.0, cost: "", qty: "", group: "观察中", note: "只关注未买入" }
];

function migrate(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      fire TEXT NOT NULL DEFAULT '{}',
      simple TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS rate_limit (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_time ON security_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_security_audit_user_time ON security_audit(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      market TEXT NOT NULL,
      price REAL NOT NULL,
      cost REAL,
      qty REAL,
      group_name TEXT,
      note TEXT,
      source TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);

    CREATE TABLE IF NOT EXISTS fund_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL CHECK(currency IN ('USD','EUR','HKD','CNY','JPY','KRW','SGD')),
      type TEXT NOT NULL CHECK(type IN ('opening','deposit','withdrawal','adjustment')),
      amount REAL NOT NULL CHECK(amount > 0),
      direction INTEGER NOT NULL CHECK(direction IN (-1,1)),
      note TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fund_transactions_user_time ON fund_transactions(user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fund_transactions_user_currency_time ON fund_transactions(user_id, currency, occurred_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS trade_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
      market TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      status TEXT NOT NULL DEFAULT 'filled' CHECK(status IN ('filled','cancelled')),
      qty REAL NOT NULL CHECK(qty > 0),
      price REAL NOT NULL CHECK(price > 0),
      fees REAL NOT NULL DEFAULT 0 CHECK(fees >= 0),
      amount REAL NOT NULL,
      realized_pnl REAL,
      position_qty_after REAL NOT NULL,
      position_cost_after REAL,
      broker TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      traded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      position_qty_before REAL,
      position_cost_before REAL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_orders_user_time ON trade_orders(user_id, traded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trade_orders_record ON trade_orders(record_id, traded_at DESC);

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS watch_groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT -1,
      kind TEXT NOT NULL DEFAULT 'custom',
      market TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_groups_user ON watch_groups(user_id);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      market_cap REAL DEFAULT 0,
      price REAL,
      change_pct REAL,
      source TEXT DEFAULT 'manual',
      last_checked_at TEXT DEFAULT '',
      board TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);

    CREATE TABLE IF NOT EXISTS etf_market_caps (
      code TEXT PRIMARY KEY,
      shares REAL,
      market_cap REAL,
      fetched_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS dividend_cache (
      market TEXT NOT NULL,
      code TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (market, code)
    );

    -- 卡面库：每张卡每位用户一条金额记录（卡面素材本身是本地文件，这里只存用户录入的数据）
    CREATE TABLE IF NOT EXISTS card_amounts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, card_key)
    );
    CREATE INDEX IF NOT EXISTS idx_card_amounts_user ON card_amounts(user_id);

    -- 卡面库：用户自建标签（虚拟卡 / 实体卡 / 收藏 …），一张卡可有多个
    CREATE TABLE IF NOT EXISTS card_tags (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, card_key, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_card_tags_user ON card_tags(user_id);

    -- 卡面库：用户「持有」的卡（默认只展示持有的卡，其余在全量库里挑选）
    CREATE TABLE IF NOT EXISTS card_holdings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, card_key)
    );
    CREATE INDEX IF NOT EXISTS idx_card_holdings_user ON card_holdings(user_id);

    CREATE TABLE IF NOT EXISTS financial_report_files (
      id TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      exchange TEXT NOT NULL,
      company_code TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      fiscal_year INTEGER NOT NULL,
      fiscal_period TEXT NOT NULL,
      report_type TEXT NOT NULL DEFAULT '',
      file_kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_url TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      schema_version TEXT NOT NULL DEFAULT '1.0',
      uploaded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_financial_report_company
      ON financial_report_files(market, exchange, company_code, fiscal_year, fiscal_period);

    CREATE TABLE IF NOT EXISTS celebs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL DEFAULT 'none',
      cik TEXT NOT NULL DEFAULT '',
      entity TEXT NOT NULL DEFAULT '',
      source_label TEXT NOT NULL DEFAULT '',
      holdings_json TEXT NOT NULL DEFAULT '[]',
      trades_json TEXT NOT NULL DEFAULT '[]',
      returns_json TEXT NOT NULL DEFAULT '{}',
      stock_icons_json TEXT NOT NULL DEFAULT '{}',
      refresh_hours INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 资金账本货币与全站展示货币保持一致。旧表的 CHECK 仅允许三币种，需无损重建约束。
  const fundTableSql =
    (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fund_transactions'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (!fundTableSql.includes("'EUR'") || !fundTableSql.includes("'SGD'")) {
    const prevFk = database.pragma("foreign_keys", { simple: true }) === 1;
    if (prevFk) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => database.exec(`
        CREATE TABLE fund_transactions_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          currency TEXT NOT NULL CHECK(currency IN ('USD','EUR','HKD','CNY','JPY','KRW','SGD')),
          type TEXT NOT NULL CHECK(type IN ('opening','deposit','withdrawal','adjustment')),
          amount REAL NOT NULL CHECK(amount > 0),
          direction INTEGER NOT NULL CHECK(direction IN (-1,1)),
          note TEXT NOT NULL DEFAULT '',
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO fund_transactions_new (id,user_id,currency,type,amount,direction,note,occurred_at,created_at)
          SELECT id,user_id,currency,type,amount,direction,note,occurred_at,created_at FROM fund_transactions;
        DROP TABLE fund_transactions;
        ALTER TABLE fund_transactions_new RENAME TO fund_transactions;
        CREATE INDEX IF NOT EXISTS idx_fund_transactions_user_time ON fund_transactions(user_id, occurred_at DESC);
      `))();
    } finally {
      if (prevFk) database.pragma("foreign_keys = ON");
    }
  }

  const userSettingCols = (database.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
  if (!userSettingCols.includes("simple")) database.exec("ALTER TABLE user_settings ADD COLUMN simple TEXT NOT NULL DEFAULT '{}'");

  // celebs 表增量字段（兼容旧库）
  const celebCols = (database.prepare("PRAGMA table_info(celebs)").all() as { name: string }[]).map((c) => c.name);
  if (!celebCols.includes("stock_icons_json")) {
    database.exec("ALTER TABLE celebs ADD COLUMN stock_icons_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!celebCols.includes("refresh_hours")) {
    database.exec("ALTER TABLE celebs ADD COLUMN refresh_hours INTEGER NOT NULL DEFAULT 0");
  }

  // activities 表增量字段（兼容旧库）
  const actCols = (database.prepare("PRAGMA table_info(activities)").all() as { name: string }[]).map((c) => c.name);
  if (!actCols.includes("market")) database.exec("ALTER TABLE activities ADD COLUMN market TEXT DEFAULT ''");
  if (!actCols.includes("price")) database.exec("ALTER TABLE activities ADD COLUMN price REAL");
  if (!actCols.includes("cost")) database.exec("ALTER TABLE activities ADD COLUMN cost REAL");
  if (!actCols.includes("qty")) database.exec("ALTER TABLE activities ADD COLUMN qty REAL");
  database.exec("CREATE INDEX IF NOT EXISTS idx_security_audit_user_time ON security_audit(user_id, created_at DESC);");

  // records 表增量字段（兼容旧库）
  const recCols = (database.prepare("PRAGMA table_info(records)").all() as { name: string }[]).map((c) => c.name);
  if (!recCols.includes("source")) database.exec("ALTER TABLE records ADD COLUMN source TEXT DEFAULT ''");
  if (!recCols.includes("watch_group_id")) database.exec("ALTER TABLE records ADD COLUMN watch_group_id TEXT DEFAULT ''");

  // 成交前快照用于可靠重放账本。旧订单按当时的平均成本规则反推一次，之后不再依赖
  // 容易被后续更正覆盖的 position_*_after 快照来猜测初始持仓。
  const orderCols = (database.prepare("PRAGMA table_info(trade_orders)").all() as { name: string }[]).map((c) => c.name);
  if (!orderCols.includes("position_qty_before")) database.exec("ALTER TABLE trade_orders ADD COLUMN position_qty_before REAL");
  if (!orderCols.includes("position_cost_before")) database.exec("ALTER TABLE trade_orders ADD COLUMN position_cost_before REAL");
  // 唯一订单号（10 位）：存量订单一次性补号 / 统一重排为 10 位，此后新订单在写入时生成。
  if (!orderCols.includes("order_no")) database.exec("ALTER TABLE trade_orders ADD COLUMN order_no TEXT DEFAULT ''");
  const fixOrderNos = database.prepare("SELECT id FROM trade_orders WHERE order_no IS NULL OR order_no = '' OR length(order_no) != 10").all() as { id: string }[];
  if (fixOrderNos.length > 0) {
    const usedOrderNos = new Set(
      (database.prepare("SELECT order_no FROM trade_orders WHERE order_no IS NOT NULL AND order_no != '' AND length(order_no) = 10").all() as { order_no: string }[])
        .map((row) => row.order_no)
    );
    const fillOrderNo = database.prepare("UPDATE trade_orders SET order_no = ? WHERE id = ?");
    database.transaction(() => {
      for (const row of fixOrderNos) {
        let candidate = generateOrderNo();
        let guard = 0;
        while (usedOrderNos.has(candidate) && guard < 100) {
          candidate = generateOrderNo();
          guard += 1;
        }
        usedOrderNos.add(candidate);
        fillOrderNo.run(candidate, row.id);
      }
    })();
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_orders_order_no ON trade_orders(order_no)");
  database.exec(`
    UPDATE trade_orders
    SET position_qty_before = CASE
      WHEN side = 'buy' THEN MAX(0, position_qty_after - qty)
      ELSE position_qty_after + qty
    END
    WHERE position_qty_before IS NULL;

    UPDATE trade_orders
    SET position_cost_before = CASE
      WHEN side = 'sell' THEN COALESCE(position_cost_after, 0)
      WHEN position_qty_after - qty > 0 THEN
        ((position_qty_after * COALESCE(position_cost_after, 0)) - (qty * price) - fees)
          / (position_qty_after - qty)
      ELSE 0
    END
    WHERE position_cost_before IS NULL;
  `);
  migrateTradeCostAccounting(database);

  // 订单引擎：trade_orders 扩展订单类型/触发价/有效期/时段 + status 支持 pending/expired。
  // 旧库 side CHECK 只允许 buy/sell，且 status 无 pending/expired，需重建表（一次到位：含 dividend side）。
  const orderTableSql =
    (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trade_orders'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (!orderTableSql.includes("'pending'") || !orderTableSql.includes("order_type")) {
    // 存量库可能存在指向已删除记录/用户的孤立订单，重建表时需临时关闭外键校验，避免迁移失败。
    const prevFk = database.pragma("foreign_keys", { simple: true }) === 1;
    if (prevFk) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
      database.exec(`
        CREATE TABLE trade_orders_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          record_id TEXT NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
          market TEXT NOT NULL,
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('buy','sell','dividend')),
          status TEXT NOT NULL DEFAULT 'filled' CHECK(status IN ('filled','cancelled','pending','expired')),
          qty REAL NOT NULL CHECK(qty > 0),
          price REAL NOT NULL CHECK(price > 0),
          fees REAL NOT NULL DEFAULT 0 CHECK(fees >= 0),
          amount REAL NOT NULL,
          realized_pnl REAL,
          position_qty_after REAL NOT NULL,
          position_cost_after REAL,
          broker TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          traded_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          position_qty_before REAL,
          position_cost_before REAL,
          order_no TEXT DEFAULT '',
          order_type TEXT NOT NULL DEFAULT 'limit',
          trigger_price REAL,
          tif TEXT NOT NULL DEFAULT 'day',
          expires_at TEXT,
          session TEXT NOT NULL DEFAULT '',
          trigger_status TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO trade_orders_new
          (id,user_id,record_id,market,code,name,side,status,qty,price,fees,amount,realized_pnl,position_qty_after,position_cost_after,broker,note,traded_at,created_at,position_qty_before,position_cost_before,order_no)
          SELECT id,user_id,record_id,market,code,name,side,status,qty,price,fees,amount,realized_pnl,position_qty_after,position_cost_after,broker,note,traded_at,created_at,position_qty_before,position_cost_before,order_no FROM trade_orders;
        DROP TABLE trade_orders;
        ALTER TABLE trade_orders_new RENAME TO trade_orders;
        CREATE INDEX IF NOT EXISTS idx_trade_orders_user_time ON trade_orders(user_id, traded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trade_orders_record ON trade_orders(record_id, traded_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_orders_order_no ON trade_orders(order_no);
      `);
      })();
    } finally {
      if (prevFk) database.pragma("foreign_keys = ON");
    }
  }

  // assets 表增量字段（股票素材库同步：市值 / 价格 / 来源 / 检测时间）
  const assetCols = (database.prepare("PRAGMA table_info(assets)").all() as { name: string }[]).map((c) => c.name);
  if (!assetCols.includes("market_cap")) database.exec("ALTER TABLE assets ADD COLUMN market_cap REAL DEFAULT 0");
  if (!assetCols.includes("price")) database.exec("ALTER TABLE assets ADD COLUMN price REAL");
  if (!assetCols.includes("change_pct")) database.exec("ALTER TABLE assets ADD COLUMN change_pct REAL");
  if (!assetCols.includes("source")) database.exec("ALTER TABLE assets ADD COLUMN source TEXT DEFAULT 'manual'");
  if (!assetCols.includes("last_checked_at")) database.exec("ALTER TABLE assets ADD COLUMN last_checked_at TEXT DEFAULT ''");
  if (!assetCols.includes("board")) database.exec("ALTER TABLE assets ADD COLUMN board TEXT DEFAULT ''");
  if (!assetCols.includes("url_dark")) database.exec("ALTER TABLE assets ADD COLUMN url_dark TEXT DEFAULT ''");

  // users 表增量字段（兼容旧库）
  const userCols = (database.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes("email")) database.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");
  if (!userCols.includes("avatar")) database.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''");
  if (!userCols.includes("role")) database.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
  if (!userCols.includes("nickname")) database.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''");
  if (!userCols.includes("uid")) database.exec("ALTER TABLE users ADD COLUMN uid TEXT DEFAULT ''");
  if (!userCols.includes("is_test")) database.exec("ALTER TABLE users ADD COLUMN is_test INTEGER DEFAULT 0");
  const legacyUid = (database
    .prepare("SELECT COUNT(*) AS n FROM users WHERE is_test = 0 AND (uid IS NULL OR uid = '' OR uid NOT GLOB '[0-9]*')")
    .get() as { n: number }).n;
  if (legacyUid > 0) {
    reassignUids(database);
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid)");
  migrateDefaultCelebAvatars(database);
  migrateDefaultFireIcon(database);
  migrateDefaultEuroFlag(database);
  migrateMissingBrokerGroups(database);
  migrateMissingAssetUrls(database);
  migrateEconomicRealizedPnl(database);
}

/**
 * 历史版本曾把 site_settings.groups 覆盖成不完整列表，但券商素材仍在。
 * 只执行一次：保留用户现有顺序，把 assets(type=broker) 中的孤立券商追加回配置。
 * 正常删除会同时删除素材，且迁移标记防止券商之后被“自动复活”。
 */
function migrateMissingBrokerGroups(database: Database.Database) {
  const migrationKey = "migration.restore_missing_broker_groups";
  const targetVersion = "2";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  const row = database.prepare("SELECT value FROM site_settings WHERE key = 'groups'").get() as { value: string } | undefined;
  let groups: { id: string; name: string; alias?: string }[] = [];
  try {
    const parsed = JSON.parse(row?.value ?? "[]");
    if (Array.isArray(parsed)) {
      groups = parsed.filter((g): g is { id: string; name: string; alias?: string } =>
        !!g && typeof g.id === "string" && typeof g.name === "string"
      );
    }
  } catch { /* 损坏的旧配置从空列表恢复 */ }

  const idKeys = new Set(groups.map((g) => g.id.trim().toLowerCase()));
  const nameKey = (value: string) => value.trim().toLocaleLowerCase("zh-CN").replace(/[\s·._-]+/g, "").replace(/证[劵卷]/g, "证券");
  const nameKeys = new Set(groups.map((g) => nameKey(g.name)));
  const knownAliases: Record<string, string> = {
    "长桥证券": "Longbridge", "华泰证券": "HTSC", "盈透证券": "IBKR", "富途证券": "Futu",
    "同花顺": "10jqka", "东方财富": "东财", "老虎证券": "Tiger", "罗宾汉": "Robinhood", "嘉信理财": "Schwab"
  };
  groups = groups.map((group) => group.alias ? group : { ...group, alias: knownAliases[nameKey(group.name)] });
  const orphaned = database.prepare(
    "SELECT code, name FROM assets WHERE type = 'broker' AND trim(code) <> '' AND trim(name) <> '' ORDER BY updated_at, rowid"
  ).all() as { code: string; name: string }[];
  orphaned.forEach((asset) => {
    const id = asset.code.trim().toLowerCase();
    const normalizedName = nameKey(asset.name);
    if (!id || !normalizedName || idKeys.has(id) || nameKeys.has(normalizedName)) return;
    groups.push({ id, name: asset.name.trim(), alias: knownAliases[normalizedName] });
    idKeys.add(id);
    nameKeys.add(normalizedName);
  });

  const save = database.transaction(() => {
    database.prepare("INSERT INTO site_settings (key,value) VALUES ('groups',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(groups));
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  });
  save();
}

/** 清空数据库中已无磁盘文件/镜像默认文件的本地素材 URL，保留素材元数据供兜底展示。 */
function migrateMissingAssetUrls(database: Database.Database) {
  const migrationKey = "migration.clear_missing_asset_urls";
  const targetVersion = "3";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  const exists = (url: string) => {
    if (!url.startsWith("/uploads/")) return true;
    let rel = url.slice("/uploads/".length);
    try { rel = decodeURIComponent(rel); } catch { /* 非法编码视为原路径 */ }
    return [path.join(process.cwd(), "public", "uploads", rel), path.join(process.cwd(), "resource-default", rel)]
      .some((file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
  };
  const brokerDirs = [
    path.join(process.cwd(), "public", "uploads", "asset", "broker"),
    path.join(process.cwd(), "resource-default", "asset", "broker")
  ];
  const brokerKey = (value: string) => value.trim().toLocaleLowerCase("zh-CN").replace(/[\s·._-]+/g, "").replace(/证[劵卷]/g, "证券");
  const brokerFiles = new Map<string, string>();
  brokerDirs.forEach((dir) => {
    try {
      fs.readdirSync(dir).filter((file) => /\.(svg|png|webp|jpe?g)$/i.test(file)).forEach((file) => {
        brokerFiles.set(brokerKey(file.replace(/\.(svg|png|webp|jpe?g)$/i, "")), file);
      });
    } catch { /* 当前部署无默认券商目录 */ }
  });
  const rows = database.prepare("SELECT id, type, name, url, url_dark FROM assets").all() as { id: string; type: string; name: string; url: string; url_dark: string }[];
  const clear = database.prepare("UPDATE assets SET url = ?, url_dark = ?, updated_at = ? WHERE id = ?");
  const apply = database.transaction(() => {
    const now = new Date().toISOString();
    rows.forEach((row) => {
      let legacyStem = "";
      if (row.type === "broker" && row.url) {
        try { legacyStem = decodeURIComponent(path.basename(row.url)).replace(/\.(svg|png|webp|jpe?g)$/i, ""); } catch { /* 忽略无效旧 URL */ }
      }
      const brokerFile = row.type === "broker"
        ? brokerFiles.get(brokerKey(row.name)) || (legacyStem ? brokerFiles.get(brokerKey(legacyStem)) : undefined)
        : undefined;
      const normalizedBrokerUrl = brokerFile ? `/uploads/asset/broker/${encodeURIComponent(brokerFile)}` : row.url;
      const url = normalizedBrokerUrl && !exists(normalizedBrokerUrl) ? "" : normalizedBrokerUrl;
      const urlDark = row.url_dark && !exists(row.url_dark) ? "" : row.url_dark;
      if (url !== row.url || urlDark !== row.url_dark) clear.run(url, urlDark, now, row.id);
    });
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  });
  apply();
}

/**
 * 线上新库曾把六位内置名人的原始照片写入 celebs.avatar，而定制头像映射只存在
 * 于开发机 data/celebs-avatars.json（该目录不会进入镜像）。仅替换明确的旧默认值，
 * 不覆盖管理员后来上传的任意自定义头像；JSON 覆盖层仍拥有最高优先级。
 */
function migrateDefaultCelebAvatars(database: Database.Database) {
  const migrationKey = "migration.default_celeb_avatars";
  const targetVersion = "custom_v1";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  const defaults: Array<[string, string[], string]> = [
    ["buffett", ["/uploads/celebs/buffett.jpg", "/uploads/celebs/buffett.png"], "/uploads/celebs/buffett-custom-1785959604596-1b74c273.png"],
    ["pelosi", ["/uploads/celebs/pelosi.jpg"], "/uploads/celebs/pelosi-custom-1786043465104-fed471cd.png"],
    ["huang", ["/uploads/celebs/huang.jpg"], "/uploads/celebs/huang-custom-1785959912531-8b437268.png"],
    ["cathie", ["/uploads/celebs/cathie.jpg"], "/uploads/celebs/cathie-custom-1786043468667-6e835ac3.png"],
    ["trump", ["/uploads/celebs/trump.jpg"], "/uploads/celebs/trump-custom-1786043526485-1e34c87e.png"],
    ["duan", ["/uploads/celebs/duan.jpg"], "/uploads/celebs/duan-custom-1785959747574-b3c57b2d.png"]
  ];

  const update = database.prepare("UPDATE celebs SET avatar = ?, updated_at = ? WHERE id = ? AND avatar = ?");
  database.transaction(() => {
    const now = new Date().toISOString();
    defaults.forEach(([id, legacyPaths, avatar]) => {
      legacyPaths.forEach((legacyPath) => update.run(avatar, now, id, legacyPath));
    });
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  })();
}

/** 将历史上误作为自定义图标的 FIRE 统一恢复为内置默认火焰图标。 */
function migrateDefaultFireIcon(database: Database.Database) {
  const migrationKey = "migration.default_fire_icon";
  const targetVersion = "fire_v1";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  database.transaction(() => {
    database.prepare(`
      UPDATE assets
      SET url = ?, url_dark = ?, updated_at = ?
      WHERE type = 'icon' AND upper(code) = 'FIRE'
    `).run("/uploads/asset/icon/fire.svg", "/uploads/asset/icon/fire-dark.svg", new Date().toISOString());
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  })();
}

/** 既有本地库与线上库都把内置欧元旗帜改为随镜像发布的「欧盟EU.svg」，不覆盖用户上传的其他 URL。 */
function migrateDefaultEuroFlag(database: Database.Database) {
  const migrationKey = "migration.default_euro_flag";
  const targetVersion = "named_eu_svg_v1";
  const targetUrl = "/uploads/asset/flag/欧盟EU.svg";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  database.transaction(() => {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT OR IGNORE INTO assets (id,type,market,code,name,url,source,updated_at)
      VALUES ('flag:EU','flag','','EU','欧盟',?,'manual',?)
    `).run(targetUrl, now);
    database.prepare(`
      UPDATE assets
      SET name = '欧盟', url = ?, updated_at = ?
      WHERE id = 'flag:EU' AND (url = '/uploads/asset/flag/eu.svg' OR url = ?)
    `).run(targetUrl, now, targetUrl);
    database.prepare(`
      DELETE FROM assets
      WHERE id = 'flag:欧盟EU' AND url = ?
    `).run(targetUrl);
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  })();
}

/**
 * 修正历史订单的已实现盈亏：旧逻辑用已被卖出回款摊薄过的成本继续计算下一次卖出，
 * 连续减仓会重复计利。只重算 realized_pnl，不改用户当前持仓数量与展示成本。
 */
function migrateEconomicRealizedPnl(database: Database.Database) {
  const migrationKey = "migration.realized_pnl_mode";
  const targetVersion = "economic_average_v1";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  const rows = database.prepare(`
    SELECT id,record_id,side,qty,price,fees,position_qty_before,position_cost_before,traded_at,created_at
    FROM trade_orders
    WHERE status = 'filled'
    ORDER BY record_id ASC, traded_at ASC, created_at ASC
  `).all() as Array<Record<string, unknown>>;
  const update = database.prepare("UPDATE trade_orders SET realized_pnl = ? WHERE id = ?");

  database.transaction(() => {
    let recordId = "";
    let qty = 0;
    let averageCost: number | null = 0;
    for (const row of rows) {
      const nextRecordId = String(row.record_id);
      if (nextRecordId !== recordId) {
        recordId = nextRecordId;
        qty = Math.max(0, Number(row.position_qty_before) || 0);
        averageCost = qty > 1e-8 && row.position_cost_before == null ? null : Number(row.position_cost_before || 0);
      }
      const tradeQty = Math.max(0, Number(row.qty) || 0);
      const price = Math.max(0, Number(row.price) || 0);
      const fees = Math.max(0, Number(row.fees) || 0);
      const side = String(row.side);
      let realized: number | null = null;

      if (side === "dividend") {
        realized = tradeQty * price - fees;
      } else if (side === "buy") {
        const nextQty = qty + tradeQty;
        if (averageCost != null && nextQty > 1e-8) {
          averageCost = (qty * averageCost + tradeQty * price + fees) / nextQty;
        }
        qty = nextQty;
      } else {
        if (averageCost != null && tradeQty <= qty + 1e-8) realized = (price - averageCost) * tradeQty - fees;
        qty = Math.max(0, qty - tradeQty);
        if (qty <= 1e-8) {
          qty = 0;
          averageCost = 0;
        }
      }
      update.run(realized == null ? null : Math.round((realized + Number.EPSILON) * 100) / 100, String(row.id));
    }
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  })();
}

/** 旧成交按券商摊薄成本口径重放一次；标记落库，后续启动不会重复迁移。 */
function migrateTradeCostAccounting(database: Database.Database) {
  const migrationKey = "migration.trade_cost_mode";
  const targetVersion = "diluted_v2";
  const applied = database.prepare("SELECT value FROM site_settings WHERE key = ?").get(migrationKey) as { value: string } | undefined;
  if (applied?.value === targetVersion) return;

  // SPCH 旧订单曾把用户输入的 8.60 错存为 8.50。限定订单 id /
  // 代码 / 数量 / 旧价格，避免影响其他成交。v2 同时会把旧的高精度成本
  // 按券商展示口径收敛到 3 位小数，使持仓盈亏与可见成本可精确对账。
  database.prepare(`
    UPDATE trade_orders
    SET price = 8.60, amount = qty * 8.60
    WHERE id = 'o-db275e4372829283' AND code = 'SPCH.AM' AND side = 'sell' AND qty = 600 AND ABS(price - 8.50) < 0.000001
  `).run();

  const rows = database.prepare(`
    SELECT id,user_id,record_id,side,qty,price,fees,position_qty_before,position_cost_before,traded_at,created_at
    FROM trade_orders
    WHERE status = 'filled'
    ORDER BY record_id ASC, traded_at ASC, created_at ASC
  `).all() as Array<Record<string, unknown>>;

  database.transaction(() => {
    let currentRecordId = "";
    let currentUserId = "";
    let qty = 0;
    let cost = 0;
    for (const row of rows) {
      const recordId = String(row.record_id);
      const userId = String(row.user_id);
      if (recordId !== currentRecordId) {
        if (currentRecordId) {
          database.prepare("UPDATE records SET qty = ?, cost = ? WHERE id = ? AND user_id = ?")
            .run(qty || null, qty > 0 ? cost : null, currentRecordId, currentUserId);
        }
        currentRecordId = recordId;
        currentUserId = userId;
        qty = Number(row.position_qty_before || 0);
        cost = Number(row.position_cost_before || 0);
      }

      const calculated = applyFilledTrade(
        { qty, cost },
        {
          side: row.side === "sell" ? "sell" : "buy",
          qty: Number(row.qty),
          price: Number(row.price),
          fees: Number(row.fees || 0)
        }
      );
      database.prepare(`
        UPDATE trade_orders
        SET realized_pnl = ?, position_qty_before = ?, position_cost_before = ?, position_qty_after = ?, position_cost_after = ?
        WHERE id = ?
      `).run(calculated.realizedPnl, qty, cost, calculated.qty, calculated.qty > 0 ? calculated.cost : null, String(row.id));
      qty = calculated.qty;
      cost = calculated.cost;
    }
    if (currentRecordId) {
      database.prepare("UPDATE records SET qty = ?, cost = ? WHERE id = ? AND user_id = ?")
        .run(qty || null, qty > 0 ? cost : null, currentRecordId, currentUserId);
    }
    database.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(migrationKey, targetVersion);
  })();
}

function reassignUids(database: Database.Database) {
  const rows = database
    .prepare("SELECT id, username, created_at, is_test FROM users")
    .all() as { id: string; username: string; created_at: string; is_test: number }[];
  // 非测试账号按注册时间先后编号；测试账号不占用 UID。
  rows.sort((a, b) => {
    return a.created_at.localeCompare(b.created_at);
  });
  const setUid = database.prepare("UPDATE users SET uid = ? WHERE id = ?");
  let i = 0;
  rows.forEach((row) => {
    if (row.is_test === 1) {
      setUid.run(null, row.id); // 测试账号 UID 为空，不占用编号
      return;
    }
    i += 1;
    setUid.run(String(i), row.id);
  });
}

function seed(database: Database.Database) {
  const userCount = (database.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (userCount === 0) {
    const isProd = process.env.NODE_ENV === "production";
    const username = isProd ? String(process.env.INITIAL_ADMIN_USERNAME ?? "").trim() : "demo";
    const password = isProd ? String(process.env.INITIAL_ADMIN_PASSWORD ?? "") : "demo1234";
    if (isProd) {
      // 生产环境：只有提供了合法的 INITIAL_ADMIN_* 才用它建管理员；
      // 未填 / 用户名超 3-20 位 / 密码不合规时，不建管理员也不抛错，
      // 交给「首个注册用户 = 管理员」逻辑（lib/auth.ts createUser）接管。
      const okUser = /^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(username);
      const okPwd = !validatePassword(password);
      if (!okUser || !okPwd) return;
    }
    const demoId = isProd ? "initial-admin" : "demo-user";
    database.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, email, avatar, role) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(demoId, username, hashPassword(password), new Date().toISOString(), isProd ? "" : "demo@fire.local", "", "admin");

    if (isProd) return;
    const insert = database.prepare(`
      INSERT INTO records (id, user_id, name, code, market, price, cost, qty, group_name, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    SEED_RECORDS.forEach((r) => {
      insert.run(
        `seed-${r.code}`,
        demoId,
        r.name,
        r.code,
        r.market,
        r.price,
        r.cost === "" ? null : r.cost,
        r.qty === "" ? null : r.qty,
        r.group,
        r.note,
        now
      );
    });
  }
}

export function getDb(): Database.Database {
  // 定时备份惰性检查（60 秒节流）：服务器运行且有访问时按计划自动备份
  maybeRunBackup();
  // 股息结算惰性检查（15 分钟节流）：到派息日自动生成股息订单
  void import("./dividendSettlement")
    .then((m) => m.maybeRunDividendSettlement())
    .catch(() => {
      /* 后台任务失败不影响主流程 */
    });
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
    db = new Database(DB_FILE);
    try { fs.chmodSync(DB_FILE, 0o600); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
    db.pragma("journal_mode = WAL");
    migrate(db);
    seed(db);
  }
  return db;
}

export function getDbStatus() {
  const database = getDb();
  const tables = (database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[])
    .map((r) => r.name);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(DB_FILE).size;
  } catch { /* 文件不存在时忽略 */ }
  return {
    type: "sqlite",
    file: DB_FILE,
    sizeBytes,
    tables
  };
}
