# App 资产合约 v1（2026-10-05，冻结；发布状态按提交分别核对）

完整联调样本：[fixtures/account-assets-v1.json](fixtures/account-assets-v1.json)。该文件由本仓库真实计算服务在隔离临时数据库中生成，包含两个虚构持仓市场、两笔虚构成交及虚构现金；不是用户账户，不含密码、Token或真实邮件信息。`schemaVersion:1` 的 data 结构在 v1/v2 相同，样本外层包含标准成功信封。

证券代码或市场被实际修改时，数据库触发器立即作废原声明并递增声明版本，即使代码随后改回也不恢复。需本人读取最新 recordRevision/instrument.revision，再显式确认。

验证：16组隔离资产合约回归（两版路径、权限、跨账号、异步撤权、UUID回执/CAS、身份改回、费用成本、现金/币种、真实空态和完整样本结构）、类型检查、全站回归及63项本地只读巡检通过。全站首次运行停在接口目录对照，修复参数名称和权限栏后从该失败点运行其余全部检查通过。无真实账户业务写入、真实SMTP、历史交易回填或手动镜像发布。

Web 与 iOS 独立。共享合约路径：`fire-web/docs/native-account-assets-contract.md`。本轮仅新增资产读取及显式现金股票/ETF资料声明，不扩展旧授权、不创建虚构历史，不把 legacy orders GET 用于后台资产刷新（该旧接口会结算挂单）。

## 旧记录兼容与发布核对（本轮）

2026-10-05 17:23 北京时间只读核对生产 `/api/health`：buildSha=`4d6151c61ff6403ae922b25407d9dce5b18dd97d`，版本v0.1.51。该提交镜像于16:32北京完成手动发布任务（GitHub Actions 运行编号37282168697，event=workflow_dispatch），生产能力已存在；此前“尚未发布”只描述当时状态。当时本轮兼容修复尚未部署；当前线上状态见下方「订单扩展 v1」核验记录，推送本身不等于部署。

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
- `cash:{balancesByCurrency:object|null,complete,source:"account_cash_reconciliation",marketAllocationAvailable:false}`。含 Web 同口径真实资金流水、成交现金和借记/预付卡现金；有来源不足、未知证券单位的成交或缺汇率则不完整。未声明旧记录的成交沿用原台账单位；现金只有币种归集；USD 不等于美股市场现金，不分摊至市场。
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

现有来源：records + revisions；trade_orders 成交/费用/快照；fund_transactions + card balances + simple-ledger 主市场权益现金对账；真实行情及汇率。没有新建成交台账，也没有历史回填。

尚缺来源：经核对的历史日初 NAV/持仓现金流、每市场券商现金子账户、供应商证券分类/退市状态、期权乘数/标的/合约身份/成交记账、常规与扩展报价独立快照、完整交易周期日初基准。这些能力发现均为 false/限定能力；iOS 应显示缺失或隐藏不支持操作。当前已发布状态见下方「订单扩展 v1」核验记录；以上缺失能力不因订单扩展上线而变为可用。

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
    "instrument_declarations": [
      "cash_equity",
      "etf",
      "unknown"
    ],
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
    "smart_market_sort": false,
    "all_orders": true,
    "batch_cancel_pending": true,
    "partial_fills": false,
    "rejected_orders": false
  },
  "defaults": {
    "currency": "USD",
    "cost_method": "diluted",
    "us_price": "observed"
  },
  "unavailable_values": "null",
  "legacy_fallback": [
    "records",
    "overview"
  ],
  "order_writes": "existing_cash_equity_contract_only_no_new_write_capability",
  "orders_version": 1,
  "orders_path": "/api/v2/account-assets/orders",
  "cancel_orders_path": "/api/v2/account-assets/orders/cancellations",
  "order_revision_field": "revision",
  "order_filters": [
    "all",
    "pending",
    "filled",
    "cancelled",
    "rejected",
    "expired"
  ]
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

## 订单扩展 v1（2026-10-07，冻结；已只读核验生产上线）

用户已告知线上更新至最新。2026-10-07 Web只读核验生产 `/api/health`：buildSha=`2c4f97fd17cedaf53a85209000069f7aad5b1fa0`，版本v0.1.52；同源v1/v2发现均有orders_version=1、固定同版路径、六种筛选，order_reads_settle=false、all_orders/batch_cancel_pending=true，rejected_orders/partial_fills=false。已发布镜像 `ghcr.io/spirei/fire-web:sha-2c4f97f` 的发布日志digest为 `sha256:d1e9b723ef12a6fafd5f3f4c86b74926af43080b58ee8a7086a5e69da3d18f32`；运行容器digest未独立读取，健康接口确认的是实际运行buildSha。

iOS对话补充只读验收：正式签名Alcor 0.2.127使用既有真实连接，两色批量撤单页成功GET scope=all，并通过accountId/source/executionModel/revision/无结算校验；真实pending数量为0，空态与禁用撤单按钮符合实际数据。iOS报告用户ledger SHA-256读取前后一致，未POST任何金融操作；运行回执 `/tmp/alcor-entry-ui.DDVsWg/results.xcresult`。这些真实账户验收结果由iOS提供，Web没有索取或复制App Bearer，也未独立读取私有账户金额和订单；pending=0不代表已经实测生产撤单成功。

本节当前上线状态不构成未来生产变更的批准；后续构建发布或更新生产容器仍须单独确认，不复用80b6800或本次已上线版本的批准。本次文档状态同步不触发服务器变更。App只有在所选同源发现 `account_assets.orders_version === 1` 且存在固定 `orders_path` / `cancel_orders_path` 后使用；旧服务器不猜路径，不调用会结算挂单的 legacy orders GET。v1/v2业务结构一致，不跨版本兜底。新增发现：

```json
{"orders_version":1,"orders_path":"/api/v2/account-assets/orders","cancel_orders_path":"/api/v2/account-assets/orders/cancellations","order_revision_field":"revision","order_filters":["all","pending","filled","cancelled","rejected","expired"]}
```

features新增 `all_orders:true,batch_cancel_pending:true,partial_fills:false,rejected_orders:false`。原 `order_writes` 字段仍只描述原现金证券下单能力，不包含本节独立的撤单入口；没有新增下单能力。v1替换全部/api/v2前缀。来源仅本人的真实 `trade_orders` 内部台账；不是券商实时订单或券商远程撤单。

### 无结算只读查询

`GET orders_path?scope=today&status=all&recordId=<可选持仓编号>`：portfolio.read。scope仅today/all，默认today；status仅all/pending/filled/cancelled/rejected/expired，默认all，对应全部、进行中、已成交、已撤单、已拒绝、已过期。未知/重复查询参数拒绝。all读取全部已有订单，不分页或截断；recordId限制本人订单中的对应持仓，无跨账号数据。成功data：

`{accountId,asOf,scope,status,recordId,source:"local_trade_ledger",executionModel:"atomic_internal_orders",items,count,settlesPendingOrders:false,dateBasis:"exchange_local_calendar_date",timeZones,unknownDateOrderIds,supportedStatuses:["pending","filled","cancelled","expired"],rejectedOrdersAvailable:false,partialFillsAvailable:false}`。

当天按每市场tradedAt的交易所本地日历日（与原资产todayOrders同口径）；未知市场或无效日期列入unknownDateOrderIds，today不猜日期，all仍包含。pending按数据库实际状态，不因读取时跨过expiresAt或价格达到触发价自行改为expired/filled。

每项字段：`id/orderNo/recordId/market/code/name/side/status/revision/recordRevision/identityMatches/qty/price/fees/amount/orderType/orderPrice/executedPrice/triggerPrice/filledQty/filledQtySource/tif/expiresAt/session/triggerStatus/tradedAt/createdAt/broker/note/currentPrice/currentPriceSource/currentPriceAt/cancellable`。

- revision：正整数订单版本，数据库插入为1；所有真实订单UPDATE（包括原Web成交/撤销/更正路径）递增，状态改回也不能复用旧版本。recordRevision为当前本人持仓版本或null；证券身份不一致时identityMatches=false、cancellable=false。
- qty/price/fees/amount/triggerPrice保留真实台账有限数值，缺失null；price是当前台账记载价，成交后可能已被执行价覆盖，不能一律标为原委托价。orderPrice只对未成交状态保留price，filled为null；executedPrice仅filled时为台账price，否则null。
- 当前引擎单笔整单成交，没有部分成交记录。filledQty仅在已知状态和有效qty下按内部整单状态解释：filled为qty，pending/cancelled/expired为0，并标filledQtySource=atomic_order_status；否则null/unavailable。这不是外部券商已成量或部分成交追踪，App不得造进度。当前数据库不记录rejected，筛选rejected为空且rejectedOrdersAvailable=false；不把失败请求伪造为拒绝订单。
- currentPrice只来自实际读取到的该市场/代码报价（含已有报价缓存）；缺失null，不能用委托价/触发价冒充。currentPriceSource=quote/quote_cache/unavailable，currentPriceAt为行情源time原文或null；异步I/O后订单版本或身份变化会丢弃旧报价。读取返回前重新检查同一grant/账号/security stamp，在最终读事务读取真实状态。
- 所有数值缺失为null，不补零；identityMatches/cancellable布尔值；revision整数，recordRevision整数|null，状态/日期/编号字符串，日期兼容原台账格式。cancellable表示内部pending且证券身份一致，不代表券商已接受撤单。

### 明确选择的批量撤单

`POST cancel_orders_path`：portfolio.write，仅App Bearer。无Cookie补权；来源Origin沿用同源App限制。JSON：

```json
{"requestId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","accountId":"<当前账号编号>","orders":[{"orderId":"o-0123456789abcdef","recordId":"<持仓编号>","market":"US","code":"TEST","revision":1,"recordRevision":1}]}
```

每次用户新确认生成小写UUID，明确1–100笔且不重复；accountId必须等于授权本人。禁止all、筛选条件、他人owner、替代数量/价格等额外字段。读完请求体再次检查同一授权，立即事务核对每笔本人订单、pending、订单revision、recordRevision、recordId/market/code和当前持仓身份；任意一笔不存在40401或不符40902，整批零变更并保存failed回执。全部核对通过后仅把明确选择的pending改为cancelled/已撤销，订单版本递增；不改变持仓、资金，不执行挂单结算，不删除成交历史。服务器不会把未选择或已成交的订单撤销。

成功data：`{requestId,kind:"cancel_orders",accountId,orderIds,state:"completed",code:0,message:"ok",completedAt,data:{items:[更新后的订单项]}}`；失败回执结构相同，state=failed，code/message真实失败，data=null。复用原asset operation_path本人持久查询，requestId与证券声明共享去重命名空间；重复40901只查询原回执，不执行第二次。超时/进后台不得自动重放；GET未找到回执也不能自动重新提交，重新读取并由用户新确认。参数/来源/授权不合法未执行，不创建业务回执。APNs不在本轮范围。
