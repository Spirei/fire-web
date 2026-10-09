# App 资产合约 v1（2026-10-05，冻结；发布状态按提交分别核对）

完整联调样本：[fixtures/account-assets-v1.json](fixtures/account-assets-v1.json)。该文件由本仓库真实计算服务在隔离临时数据库中生成，包含两个虚构持仓市场、两笔虚构成交及虚构现金；不是用户账户，不含密码、Token或真实邮件信息。`schemaVersion:1` 的 data 结构在 v1/v2 相同，样本外层包含标准成功信封。

证券代码或市场被实际修改时，数据库触发器立即作废原声明并递增声明版本，即使代码随后改回也不恢复。需本人读取最新 recordRevision/instrument.revision，再显式确认。

验证：16组隔离资产合约回归（两版路径、权限、跨账号、异步撤权、UUID回执/CAS、身份改回、费用成本、现金/币种、真实空态和完整样本结构）、类型检查、全站回归及63项本地只读巡检通过。全站首次运行停在接口目录对照，修复参数名称和权限栏后从该失败点运行其余全部检查通过。无真实账户业务写入、真实SMTP、历史交易回填或手动镜像发布。

Web 与 iOS 独立。共享合约路径：`fire-web/docs/native-account-assets-contract.md`。本轮仅新增资产读取及显式现金股票/ETF资料声明，不扩展旧授权、不创建虚构历史，不把 legacy orders GET 用于后台资产刷新（该旧接口会结算挂单）。

## 旧记录兼容与发布核对（本轮）

2026-10-05 17:23 北京时间只读核对生产 `/api/health`：buildSha=`4d6151c61ff6403ae922b25407d9dce5b18dd97d`，版本v0.1.51。该提交镜像于16:32北京完成手动发布任务（GitHub Actions 运行编号37282168697，event=workflow_dispatch），生产能力已存在；此前“尚未发布”只描述当时状态。本轮兼容修复尚未部署，推送不等于生产运行此修复。

旧 `buildOverview` 用 price×qty 和 cost×qty；`orders.executeOrder/fillPendingRow` 把 amount 写为 qty×price，费用另列；`tradeAccounting.applyOrder` 也沿此单位合约计算成本和股息。这足以证明**应用原台账的记账单位**，不足以证明证券是正股、ETF或期权。无需数据库迁移或逐项确认即可恢复原台账估值，绝不补证券类型、乘100、造历史或宣称是券商期权合约市值。

新增 `positions.valuationBasis:"legacy_record_unit"|"owner_declared_unit"|"unavailable"`，`valuationUnitMultiplier:1|null`。仅在没有本人声明行时使用 legacy_record_unit，单位乘数1指原 price/cost 每个 qty 记账单位，**不是** instrument.multiplier（证券合约乘数）。旧记录 instrument.kind=unknown、multiplier=null、source=unavailable 保持不变；iOS不得因 kind=unknown 丢弃已可计算的 marketValue/cost/holdingPnl，应以 active/valuationComplete/金额缺失判断，并可提示“原台账单位”。有匹配的股票/ETF本人声明时为 owner_declared_unit；显式 unknown 或身份变更后作废的声明为 unavailable，不能被兼容路径覆盖，只有这些记录需要本人按既有CAS资料接口确认。

可恢复字段：positions 原币/换算市值、摊薄成本、持仓盈亏和权重，markets 原币/换算市值与盈亏，summary 总市值/总成本/持仓盈亏/真实币种现金/总资产。数据来源齐全时完整可用；缺单价、成本、币种/汇率、现金来源或订单身份不匹配仍缺失，绝不以0补全。现金和已有订单沿同一记录单位，订单身份须与当前持仓匹配。平均成本仍要求真实从零完整周期；没有历史不得生成。读取不写 records、声明、订单、资金或回执，无真实账户迁移范围。

iOS严格放行条件：连接的匿名发现必须有 `features.legacy_record_valuation === "stored_unit_price_times_quantity"`；行 valuationBasis=legacy_record_unit、valuationUnitMultiplier=1，且 instrument.kind=unknown/multiplier=null/source=unavailable/revision=0/identityMatches=false/updatedAt=null。这组条件对应后端“没有声明行”，并非所有kind未知都允许。实际金额仍需独立检查null/valuationComplete；价格或数量不能据字段名自行补零。旧服务没有新增能力/字段时保持原严格判断，不放行legacy。用户显式unknown即使revision>0且identityMatches=true，也必须valuationBasis=unavailable/valuationUnitMultiplier=null；作废行亦如此，不可按kind或source单独推断。

本轮验证：24组隔离资产回归、16组原资产总览、17组records、10组v2、5组接口目录、166组页面回归及63项本地只读巡检通过，类型检查通过；兼容回归对照首页同源汇总，并检查读取前后业务表不变。

新增完整标准信封样本：[旧记录完整可用](fixtures/account-assets-legacy-v1.json)、[旧记录与本人显式未知混合](fixtures/account-assets-legacy-unknown-v1.json)。前者无证券声明但totalMarket=142/totalCost=102/totalCash=457/totalAsset=599，类型全unknown；后者新增显式unknown活跃仓，旧记录金额仍可显示，完整总市值和总资产为null，不用部分和冒充总额。两者由真实计算服务在临时数据库生成，均无真实账户写入。

features 新增 `legacy_record_valuation:"stored_unit_price_times_quantity"`；schemaVersion/路径/权限不变。今日同源价格变化可由iOS使用首页完整周期输入，必须区别于本接口真实账户 dayPnl，后者继续null；市场现金和期权/标的合并继续不可用。现有首页overview只作计算口径对照，不在资产请求拼接另一时点/账户的overview结果。

## 发现与权限

本次兼容新增字段：`cash.nativeBalancesByCurrency:Record<string,number>|null`、`cash.sourceComplete:boolean`，用于显示无需汇率换算的真实原币现金。只有底层现金来源和证券单位可核对时 sourceComplete=true；缺汇率不会隐藏原币现金，汇总现金 totalCash 及旧 balancesByCurrency/complete 仍保持原来的缺失规则。App不得把 sourceComplete 当作已换算总额完整。

`positions.valuationUnavailableReason:string|null` 说明估值缺失原因：instrument_unclassified（本人声明未知或原声明已失效）、unsupported_position_quantity（数量缺失或不支持）、missing_price（缺少所选口径报价）、missing_exchange_rate（缺汇率/币种）、invalid_valuation_amount（金额不可计算）。完整估值为null原因，不把未知值显示为零。

平均成本只核对当前从零开仓周期：更早已结束周期缺少数量快照，不再阻断一个可以独立核对的新周期；当前周期缺快照、身份不匹配、链条无法对平，或历史成交日期无法确定，仍返回缺失。版本、权限及旧字段保持兼容。

优化验证：20组资产合约测试、166组页面与设置回归、原资产总览/records/v2迁移/接口文档回归及63项本地只读巡检通过。历史成交时间无效时，不猜清仓日期，列入unknownDateOrderIds。证券声明、订单和日期在单次快照内建立索引；复用固定市场的时区格式器，不缓存用户账户响应。

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
- `cash:{balancesByCurrency:object|null,complete,source:"recorded_cash_ledger",marketAllocationAvailable:false}`。含 Web 同口径真实资金流水、成交现金和借记/预付卡现金；有来源不足、未知证券单位的成交或缺汇率则不完整。未声明旧记录的成交沿用原台账单位；现金只有币种归集；USD 不等于美股市场现金，不分摊至市场。
- `positions:[]` 全量本人记录，含 active 标记，便于客户端固定持仓分组、多市场/退市/清仓筛选。每行 `recordId,recordRevision,name,code,market,broker,currency,instrument,valuationBasis,valuationUnitMultiplier,qty,price,priceSource,priceAt,quoteSession,quoteSource,quoteCached,cost,dilutedCost,averageOpenCost,costMethod,averageCostComplete,costUnavailableReason,cycleStartedAt,nativeMarketValue,nativeCostValue,nativeHoldingPnl,valuationCurrency,marketValue,costValue,holdingPnl,holdingPnlPct,dayPnl,dayPnlPct,dayPnlUnavailableReason,weightPct,clearedAt,clearedToday,active,valuationComplete,rawRecord`。nativeMarketValue 原币，marketValue/costValue/holdingPnl 为显示币种；qty/price/cost 为原记录单位及原币单价。`rawRecord` 与原 records 模型相同。
- `instrument:{kind:"cash_equity"|"etf"|"unknown",listingStatus:"listed"|"delisted"|"unknown",multiplier:1|null,underlyingRecordId:null,source:"owner_declared"|"unavailable",revision,identityMatches,updatedAt}`。旧记录不自动猜类型；没有声明行时沿用原 records/overview 的记录单位记账，类型仍 unknown。本人显式声明 unknown 或已作废的声明行仍阻断估值，不覆盖其意图。代码/市场被改后旧声明失效，需新 recordRevision 再确认。名称不推断 ETF、期权或退市状态。
- `markets:[]` 含有活跃持仓或今日订单的市场：`market,currency,valuationCurrency,nativeMarketValue,nativeHoldingPnl,date,timeZone,positionCount,marketValue,holdingPnl,cash:null,cashUnavailableReason,dayPnl:null,sessionStatus:"unknown"`。currency 标原市场结算币种；valuationCurrency 等于顶层 currency，marketValue/holdingPnl 均为该显示币种；nativeMarketValue/nativeHoldingPnl 为currency原币。空市场与未知市场不伪造现金。
- `todayOrders:{items:TradeOrder[],count,available:true,emptyReason:null|"no_recorded_orders_today",dateBasis:"exchange_local_calendar_date",timeZones,unknownDateOrderIds,settlesPendingOrders:false}`。真实 trade_orders；包括记录的 filled/pending/cancelled/expired，count 为 items 数量；历史没有订单就是空，绝不从持仓倒造。逐市场本地日历日，不按设备时区，也不把美股夜盘交易周期等同日历日。未知市场时区/无效成交时间列入 unknownDateOrderIds，不猜今日。无分页截断，不执行挂单结算。订单字段使用既有 TradeOrder（id/orderNo/recordId/market/code/name/side/status/qty/price/fees/amount/realizedPnl/positionQtyBefore/positionCostBefore/positionQtyAfter/positionCostAfter/broker/note/orderType/triggerPrice/tif/expiresAt/session/triggerStatus/tradedAt/createdAt）。
- `unavailable` 列出未具备的数据能力。

摊薄成本沿真实 records.cost；平均开仓成本仅回放已核对的从零买入完整当前周期（买入包含费用，卖出不改变剩余平均成本），数量链、现金金额及最后持仓成本必须与当前快照相符；非零旧仓起点/手改后无法对平时 null。cycleStartedAt 仅该真实完整周期首笔，未知不猜。持仓盈亏为该成本模式的未实现盈亏，不叫累计已实现利润。

当日账户和持仓盈亏本轮均 null：现有 quote.prevClose 不证明昨日持仓/资金/完整交易周期，更不能 `(现价-昨收)*现有数量` 冒充真实当日资产盈亏。今日清仓只来自当前仍为空且最后一笔真实卖出降至零的记录，按该市场本地日历日；qty 原始 null 不单独当成零。退市仅本人声明。

observed 使用实际获得的行情或 record.price 并携带来源/时间/实际 session；regular 美股仅使用实际 session=REGULAR 报价，缺失 null，不把盘前盘后价格当盘中，不假造常规快照。不存在独立 regular 报价源/完整夜盘基准。市场智能交易排序能力 false；不能凭时钟假装市场真实开市。期权乘数、衍生品身份/标的关系与合并展示能力 false，旧记录单位记账不证明证券为股票，也不提供期权合约估值；不可通过现有现金股票 orders 写入期权。

## 证券资料维护（用户显式提交）

`GET instrument_path` → `{recordId,recordRevision,market,code,instrument}`。

`PUT instrument_path` 必须 portfolio.write，先 GET 当前版本，由用户确认：

```json
{"requestId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","recordRevision":1,"revision":0,"kind":"cash_equity","listingStatus":"unknown"}
```

requestId 小写 UUID，每次新确认新 ID；revision 为 instrument.revision，首次0；recordRevision 为当前真实记录 revision。kind 仅 cash_equity/etf/unknown，拒绝 option 与未知字段。此声明是本人提供的资料，不是行情供应商确认；不会改原记录数量、成本、订单或现金。成功 `data:{requestId,recordId,accountId,state:"completed",code:0,message:"ok",data:GET结构,completedAt}`。版本冲突40902/不存在40401生成持久失败回执；重复请求40901，不能重放。已提交后超时/进后台只读查询 operation_path；返回 state completed/failed、code、message、data、completedAt。未查询到404不代表可以自动重发；重新读取后由用户新确认。

## 实際来源及待补

现有来源：records + revisions；trade_orders 成交/费用/快照；fund_transactions + card balances + simple-ledger 导入权益完整性检查（不从权益反推现金）；真实行情及汇率。没有新建成交台账，也没有历史回填。

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
    "cash_price_independent": true,
    "cash_valuation": "recorded_cash_ledger_price_independent",
    "imported_equity_requires_opening_cash": true,
    "cash_by_market": false,
    "today_orders": true,
    "order_reads_settle": false,
    "instrument_declarations": ["cash_equity", "etf", "unknown"],
    "derivatives": false,
    "underlying_merge": false,
    "listing_status": "owner_declared",
    "average_open_cost": "reconciled_zero_opening_cycle_only",
    "diluted_cost": "stored_position_cost",
    "legacy_record_valuation": "stored_unit_price_times_quantity",
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

positions.weightPct 分母为**全账户所有 active 持仓的完整显示币种总市值**，不含现金，不是同市场。任何持仓缺可用记账单位/价格/汇率，或总市值为0时所有行 null。百分比数字12.34表示12.34%。

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

## 报价独立现金修正（2026-10-09，冻结；待发布）

本节已从c8f607e隔离修复合入c48ad2b主线，待发布和部署。保留主线已恢复的资产配置，订单扩展与APNs仍保持撤回状态。旧80b6800/c8f607e及旧cash.sourceComplete=true可能仍是“导入权益减当前市值”的残差，不能作为独立现金。新同源发现明确新增可选 `account_assets.features.cash_price_independent=true`，以及cash_valuation=recorded_cash_ledger_price_independent、imported_equity_requires_opening_cash=true。缺省/false不得启用本机NAV投影；schemaVersion、API版本、权限和账号身份不变，overview/account-assets同源口径。

现金只取已记录资金台账（期初、收支、调整及内部卡转账）+真实filled订单的有符号成交现金流+已记录借记/预付卡余额。自动订单流水不重复计入，pending/cancelled/expired不扣现金；买入扣成交金额及费用，卖出/股息加净回款，允许负现金。现金不是券商直连认证余额，不把独立于报价等同外部机构核验；只证明本站已有台账可核算。当前价格、持仓市值、当日盈亏、投资权益、证券名称不参与现金推算。

旧简化账本正数且有market关联的invest.amount是总权益，不是期初现金。若其结算币种没有本人明确记录的资金type=opening，缺少现金基线；有入金/银行卡余额也不能从权益补造剩余现金。受影响币种为缺失（内部NaN、JSON null），现金整体sourceComplete=false/nativeBalancesByCurrency=null/summary.totalCash=null/totalAsset=null，仍保留真实持仓市值。对应unavailableReasons含missing_explicit_opening_cash_for_imported_equity及missingOpeningCurrencies。读取不自动补期初、改流水、迁移权益或冻结上一轮反推余额。用户需核对其账户完整现金台账后明确记录期初现金；不能把导入总权益直接录成期初现金。其他损坏来源、未知卡币种或订单单位无法核对仍返回缺失。不存在导入权益时沿用本站资金台账的记录净额与真实空账零，不声称证明外部未记录账户不存在。

account-assets.cash保留原字段，source改为recorded_cash_ledger，新增valuationIndependent=true、unavailableReasons:string[]、missingOpeningCurrencies:string[]。sourceComplete=true只允许独立现金来源、已成交单位及有限余额均有效；缺汇率不隐藏已确认原币现金。overview新增cashSource=recorded_cash_ledger、cashValuationIndependent=true、cashSourceComplete、cashUnavailableReasons、missingOpeningCashCurrencies，现金/总资产仍按完整性返回null。cash_price_independent是服务器算法能力，不代表任意账号当前现金完整。

App本机投影只能在同源所选API/grant/account、安全凭据代次一致、新发现cash_price_independent=true、cash.sourceComplete=true、valuationIndependent=true、source=recorded_cash_ledger且原币现金全部有效时使用；新报价还需持仓身份/recordRevision/数量、估值单位、市场币种与原币汇率校验，缺任一输入保持缺失。不得从盈亏差额拼NAV，不把报价更新当作现金观察更新。现金asOf沿用服务端快照观察时间，不伪造最新时间；仅报价变化现金保持同一个已确认值，NAV随真实市值变化。

来源/授权/API版本/账号/安全凭据或缓存代次变化立即使旧现金失效；已知收支、成交、现金记录修改后必须重新读取确认，不能复用变更前现金。新响应sourceComplete=false或null、缺失/不符来源或能力撤销时立即撤掉旧完整总额，禁止以缓存113580.83兜底。异步返回保持请求代次顺序，不能旧响应覆盖新现金。报价/记录/现金/汇率任务可分别更新；客户端需明确现金观察时间与有效性，独立任务本身不延长现金有效期。后续来源规则变化须新发现或合同约束，不让旧能力true绕过新缺失状态。

本轮不修改iOS源码/版本、不自动发布生产。待批准并部署后以health真实buildSha与同源能力核验，再由iOS既有授权只读核对现金不反变与资产响应；此前在线113580.83现象不作为修正已上线的证据。
