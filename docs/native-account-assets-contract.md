# App 资产合约 v1（2026-10-05，冻结；已实现并验证，待镜像发布）

完整联调样本：[fixtures/account-assets-v1.json](fixtures/account-assets-v1.json)。该文件由本仓库真实计算服务在隔离临时数据库中生成，包含两个虚构持仓市场、两笔虚构成交及虚构现金；不是用户账户，不含密码、Token或真实邮件信息。`schemaVersion:1` 的 data 结构在 v1/v2 相同，样本外层包含标准成功信封。

证券代码或市场被实际修改时，数据库触发器立即作废原声明并递增声明版本，即使代码随后改回也不恢复。需本人读取最新 recordRevision/instrument.revision，再显式确认。

验证：16组隔离资产合约回归（两版路径、权限、跨账号、异步撤权、UUID回执/CAS、身份改回、费用成本、现金/币种、真实空态和完整样本结构）、类型检查、全站回归及63项本地只读巡检通过。全站首次运行停在接口目录对照，修复参数名称和权限栏后从该失败点运行其余全部检查通过。无真实账户业务写入、真实SMTP、历史交易回填或手动镜像发布。

Web 与 iOS 独立。共享合约路径：`fire-web/docs/native-account-assets-contract.md`。本轮仅新增资产读取及显式现金股票/ETF资料声明，不扩展旧授权、不创建虚构历史，不把 legacy orders GET 用于后台资产刷新（该旧接口会结算挂单）。

## 发现与权限

匿名同源 `GET /api/v{1,2}/auth/config` 的 `data.account_assets.version===1` 才启用。本连接固定选定的 v1/v2，不跨版本重试、不追随外部路径。不存在能力时保留既有 records/overview；已声明但读取失败应显示失败，不用另一账号缓存兜底。

```json
{"version":1,"snapshot_path":"/api/v2/account-assets","instrument_path":"/api/v2/account-assets/instruments/{recordId}","operation_path":"/api/v2/account-assets/operations/{requestId}","read_scope":"portfolio.read","write_scope":"portfolio.write","snapshot_revision_field":"snapshotRevision","record_collection_revision_field":"collectionRevision","request_id_field":"requestId","idempotency":"reject-duplicate-query-original","automatic_mutation_replay":false}
```

v1 的所有路径替换为 `/api/v1`。新私有接口仅 App Bearer，Cookie 无法补权限。成功 `{code:0,message:"ok",data:...}`；失败 HTTP + `{code,message}`。no-store/private。`snapshotRevision` 为经济输入哈希，不可排序；绑定本人账户、records 集合版本、订单、证券声明、现金、汇率和已接收行情。与 `asOf` 观察时间独立。返回前外部 I/O 后重新校验同一 grant/账号/安全凭据，在 SQLite 同一读事务内重新读取最终账户数据；record 身份或 revision 变化时丢弃旧行情。

## 资产快照

`GET snapshot_path?currency=USD&costMethod=diluted&usPrice=observed`。仅支持上述三个查询字段；costMethod 为 diluted / average_open，usPrice 为 observed / regular。参数不自动保存，不是修改账户；iOS 展示偏好自行按既有偏好规则持久化。

`data` 完整字段：

- `schemaVersion:1, accountId, profile:{accountId,username,nickname,uid,avatar}, collectionRevision, snapshotRevision, asOf, currency, options:{currency,costMethod,usPrice}`。
- `summary:{totalMarket,totalCost,holdingPnl,totalCash,totalAsset,holdingsComplete,costComplete,cashComplete,totalAssetComplete,dayPnl,dayPnlPct,dayPnlUnavailableReason,unconvertedCurrencies}`。金额为 currency，百分比为百分数。未知项 null；有不完整持仓时总市值和总资产 null，不能显示部分和当完整总额。无持仓的真实零与未知分开。
- `cash:{balancesByCurrency:object|null,complete,source:"account_cash_reconciliation",marketAllocationAvailable:false}`。含 Web 同口径真实资金流水、成交现金和借记/预付卡现金；有来源不足、未知证券单位的成交或缺汇率则不完整。现金只有币种归集；USD 不等于美股市场现金，不分摊至市场。
- `positions:[]` 全量本人记录，含 active 标记，便于客户端固定持仓分组、多市场/退市/清仓筛选。每行 `recordId,recordRevision,name,code,market,broker,currency,instrument,qty,price,priceSource,priceAt,quoteSession,quoteSource,quoteCached,cost,dilutedCost,averageOpenCost,costMethod,averageCostComplete,costUnavailableReason,cycleStartedAt,nativeMarketValue,nativeCostValue,nativeHoldingPnl,valuationCurrency,marketValue,costValue,holdingPnl,holdingPnlPct,dayPnl,dayPnlPct,dayPnlUnavailableReason,weightPct,clearedAt,clearedToday,active,valuationComplete,rawRecord`。nativeMarketValue 原币，marketValue/costValue/holdingPnl 为显示币种；qty/price/cost 为原记录单位及原币单价。`rawRecord` 与原 records 模型相同。
- `instrument:{kind:"cash_equity"|"etf"|"unknown",listingStatus:"listed"|"delisted"|"unknown",multiplier:1|null,underlyingRecordId:null,source:"owner_declared"|"unavailable",revision,identityMatches,updatedAt}`。旧记录不自动猜类型，需本人显式声明 cash_equity/etf 后才计算数量×单价。未知类型金额 null。代码/市场被改后旧声明失效，需新 recordRevision 再确认。名称不推断 ETF、期权或退市状态。
- `markets:[]` 含有活跃持仓或今日订单的市场：`market,currency,valuationCurrency,nativeMarketValue,nativeHoldingPnl,date,timeZone,positionCount,marketValue,holdingPnl,cash:null,cashUnavailableReason,dayPnl:null,sessionStatus:"unknown"`。currency 标原市场结算币种；valuationCurrency 等于顶层 currency，marketValue/holdingPnl 均为该显示币种；nativeMarketValue/nativeHoldingPnl 为currency原币。空市场与未知市场不伪造现金。
- `todayOrders:{items:TradeOrder[],count,available:true,emptyReason:null|"no_recorded_orders_today",dateBasis:"exchange_local_calendar_date",timeZones,unknownDateOrderIds,settlesPendingOrders:false}`。真实 trade_orders；包括记录的 filled/pending/cancelled/expired，count 为 items 数量；历史没有订单就是空，绝不从持仓倒造。逐市场本地日历日，不按设备时区，也不把美股夜盘交易周期等同日历日。未知市场时区/无效成交时间列入 unknownDateOrderIds，不猜今日。无分页截断，不执行挂单结算。订单字段使用既有 TradeOrder（id/orderNo/recordId/market/code/name/side/status/qty/price/fees/amount/realizedPnl/positionQtyBefore/positionCostBefore/positionQtyAfter/positionCostAfter/broker/note/orderType/triggerPrice/tif/expiresAt/session/triggerStatus/tradedAt/createdAt）。
- `unavailable` 列出未具备的数据能力。

摊薄成本沿真实 records.cost；平均开仓成本仅回放已核对的从零买入完整当前周期（买入包含费用，卖出不改变剩余平均成本），数量链、现金金额及最后持仓成本必须与当前快照相符；非零旧仓起点/手改后无法对平时 null。cycleStartedAt 仅该真实完整周期首笔，未知不猜。持仓盈亏为该成本模式的未实现盈亏，不叫累计已实现利润。

当日账户和持仓盈亏本轮均 null：现有 quote.prevClose 不证明昨日持仓/资金/完整交易周期，更不能 `(现价-昨收)*现有数量` 冒充真实当日资产盈亏。今日清仓只来自当前仍为空且最后一笔真实卖出降至零的记录，按该市场本地日历日；qty 原始 null 不单独当成零。退市仅本人声明。

observed 使用实际获得的行情或 record.price 并携带来源/时间/实际 session；regular 美股仅使用实际 session=REGULAR 报价，缺失 null，不把盘前盘后价格当盘中，不假造常规快照。不存在独立 regular 报价源/完整夜盘基准。市场智能交易排序能力 false；不能凭时钟假装市场真实开市。期权乘数、衍生品身份/标的关系与合并展示能力 false，所有未声明证券不可用普通股票公式；不可通过现有现金股票 orders 写入期权。

## 证券资料维护（用户显式提交）

`GET instrument_path` → `{recordId,recordRevision,market,code,instrument}`。

`PUT instrument_path` 必须 portfolio.write，先 GET 当前版本，由用户确认：

```json
{"requestId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","recordRevision":1,"revision":0,"kind":"cash_equity","listingStatus":"unknown"}
```

requestId 小写 UUID，每次新确认新 ID；revision 为 instrument.revision，首次0；recordRevision 为当前真实记录 revision。kind 仅 cash_equity/etf/unknown，拒绝 option 与未知字段。此声明是本人提供的资料，不是行情供应商确认；不会改原记录数量、成本、订单或现金。成功 `data:{requestId,recordId,accountId,state:"completed",code:0,message:"ok",data:GET结构,completedAt}`。版本冲突40902/不存在40401生成持久失败回执；重复请求40901，不能重放。已提交后超时/进后台只读查询 operation_path；返回 state completed/failed、code、message、data、completedAt。未查询到404不代表可以自动重发；重新读取后由用户新确认。

## 实際来源及待补

现有来源：records + revisions；trade_orders 成交/费用/快照；fund_transactions + card balances + simple-ledger 主市场权益现金对账；真实行情及汇率。没有新建成交台账，也没有历史回填。

尚缺来源：经核对的历史日初 NAV/持仓现金流、每市场券商现金子账户、供应商证券分类/退市状态、期权乘数/标的/合约身份/成交记账、常规与扩展报价独立快照、完整交易周期日初基准。这些能力发现均为 false/限定能力；iOS 应显示缺失或隐藏不支持操作。生产尚未发布；完成测试并推送后更新本文件状态。

## 完整能力 JSON（v2；v1 路径按所选版本）

```json
{
  "version": 1,
  "snapshot_path": "/api/v2/account-assets",
  "instrument_path": "/api/v2/account-assets/instruments/{recordId}",
  "operation_path": "/api/v2/account-assets/operations/{requestId}",
  "read_scope": "portfolio.read",
  "write_scope": "portfolio.write",
  "snapshot_revision_field": "snapshotRevision",
  "record_collection_revision_field": "collectionRevision",
  "request_id_field": "requestId",
  "idempotency": "reject-duplicate-query-original",
  "automatic_mutation_replay": false,
  "features": {
    "cash_by_currency": true,
    "cash_by_market": false,
    "today_orders": true,
    "order_reads_settle": false,
    "instrument_declarations": ["cash_equity", "etf", "unknown"],
    "derivatives": false,
    "underlying_merge": false,
    "listing_status": "owner_declared",
    "average_open_cost": "reconciled_zero_opening_cycle_only",
    "diluted_cost": "stored_position_cost",
    "account_day_pnl": false,
    "position_day_pnl": false,
    "extended_hours": "observed_quote_only",
    "regular_hours_price_selection": false,
    "smart_market_sort": false
  },
  "defaults": {"currency": "USD", "cost_method": "diluted", "us_price": "observed"},
  "unavailable_values": "null",
  "legacy_fallback": ["records", "overview"],
  "order_writes": "existing_cash_equity_contract_only_no_new_write_capability"
}
```

iOS 用 features.smart_market_sort/underlying_merge/derivatives 禁用相应操作。两种成本显示模式可选择，但 average_open_cost 是有条件的算法，每行仍需检查 averageCostComplete 和成本 null。regular_hours_price_selection=false 表示没有独立常规报价源；usPrice=regular 只是丢弃非 REGULAR 美股报价，不保证取得常规价。

positions 新增 `valuationCurrency:string`，固定等于顶层 currency；`nativeCostValue:number|null` 和 `nativeHoldingPnl:number|null` 为行 currency 的原币金额。markets 新增 `valuationCurrency:string`、`nativeMarketValue:number|null`、`nativeHoldingPnl:number|null`。markets.currency 是市场原币，marketValue/holdingPnl 是 valuationCurrency；App 按原币展示时必须用 nativeMarketValue/nativeHoldingPnl，不得给 USD 金额贴 HKD 标签。缺显示汇率不影响已有原币值。

positions.weightPct 分母为**全账户所有 active 持仓的完整显示币种总市值**，不含现金，不是同市场。任何持仓缺类型/价格/汇率，或总市值为0时所有行 null。百分比数字12.34表示12.34%。

### TradeOrder 精确类型

资产接口保留原始未知数量快照为 null，与旧 orders 强制转成0不同。

| 字段 | 类型/含义 |
| --- | --- |
| id/orderNo/recordId/market/code/name/broker/note | string；空 orderNo 是旧台账未登记编号 |
| side | "buy" / "sell" / "dividend" |
| status | "filled" / "pending" / "cancelled" / "expired" |
| qty/price/fees/amount | number；原币、原记录单位。期权不支持，不自动乘100 |
| realizedPnl | number|null；原币台账已实现收益，不是日内资产盈亏 |
| positionQtyBefore/positionQtyAfter | number|null；未知历史快照不当0 |
| positionCostBefore/positionCostAfter | number|null；原币摊薄单位成本 |
| orderType | "limit" / "market" / "trigger_buy" / "trigger_sell" / "rebound_buy" / "rebound_sell" |
| triggerPrice | number|null；原币单位价格 |
| tif | "day" / "gtc" / "custom" |
| expiresAt | string|null；可能是YYYY-MM-DD或日期时间，不统一当epoch |
| session/triggerStatus | string；真实台账原文，空串未知 |
| tradedAt/createdAt | string；正常写入为ISO8601 UTC毫秒，旧无效时间归为 unknownDateOrderIds |

count 为当天所有以上状态的 items 总数，dividend 也计入真实记账条目。如 App 只展示 status=filled，自行过滤并标为“成交条数”；空态仅证明没有记录的当日订单。策略字段保留真实台账值，App 不需要策略入口。

其他数值：qty/price/cost/dilutedCost/averageOpenCost 和金额为number|null，revision/recordRevision/collectionRevision/positionCount/count 为整数；asOf/updatedAt/cycleStartedAt/clearedAt/priceAt 为string|null（asOf必有ISO UTC，priceAt保持行情源原文，可能是交易所本地时间）；timeZone为IANAstring|null、date为YYYY-MM-DD|null，完整性为boolean。
