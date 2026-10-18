# 原生券商资金账本 v1（本次实现）

2026-10-18。本文件描述已实现源码协议；是否可调用以用户手动更新后实际auth/config发现为准。后续卡包/券商划转、复杂历史期初核对和分账户购买力见 [后续方案](native-broker-cash-roadmap.md)，不可当作当前能力。

## 发现与边界

各v1/v2的broker_accounts.cash_ledger：

```json
{
  "version": 1,
  "supported": true,
  "read_models": {
    "version": 1,
    "entry_balance_after": true,
    "activity_summary": true,
    "withdrawal_capacity": true,
    "statement_snapshot_scope": "broker_currency"
  },
  "summary_path": "/api/v2/broker-accounts/cash",
  "account_path": "/api/v2/broker-accounts/{accountId}/cash",
  "entries_path": "/api/v2/broker-accounts/{accountId}/cash/entries",
  "preview_path": "/api/v2/broker-accounts/cash/preview",
  "submit_path": "/api/v2/broker-accounts/cash/submissions",
  "operation_path": "/api/v2/broker-accounts/operations/{requestId}",
  "read_scope": "portfolio.read",
  "write_scope": "portfolio.write",
  "actions": [
    "opening",
    "external_deposit",
    "external_withdrawal"
  ],
  "transfer_counterparties": [],
  "opening_bases": [
    "allocate_verified_unallocated_checkpoint",
    "new_external_opening"
  ],
  "cash_basis": "single_global_ledger_attribution",
  "currency_policy": "explicit_supported_currency",
  "supported_currencies": [
    "USD",
    "EUR",
    "HKD",
    "CNY",
    "JPY",
    "KRW",
    "SGD",
    "GBP",
    "AUD",
    "CAD",
    "TWD",
    "MOP",
    "INR",
    "BRL"
  ],
  "trading_cash_basis": "owner_currency_ledger",
  "trading_enforced": false,
  "preview_required": true,
  "automatic_mutation_replay": false,
  "cross_currency_transfer": false,
  "official_cash_auto_post": false
}
```

路径必须取所选API版本的同源发现，不拼v2猜测；旧scope不自动扩权。账户现金**余额可读写，但不是分账户购买力**：当前交易继续按本人总币种现金执行，可能出现券商现金负数；available/reserved始终null，不显示“该券商可买”。卡包转移、券商间转移和换汇均不支持，页面不得用external入出金冒充；仅在actions/transfer_counterparties真实声明后启用。

唯一全局现金来源继续是手工fund、真实filled订单和已持有卡包现金。券商现金是同一来源的归属投影，绝不再加到总资产。未归属旧现金/成交保留unallocated，不按名称自动搬家。

## 读取

GET account_path：

```json
{"userId":"owner","brokerAccountId":"ba-…","brokerRevision":3,"globalCashRevision":"64hex","snapshotRevision":"64hex","holdingSource":"manual","asOf":"ISO","tradingCashBasis":"owner_currency_ledger","currencies":[{"currency":"USD","cashRevision":0,"state":"uninitialized","opening":null,"balance":null,"available":null,"reserved":null,"complete":false,"unavailableReasons":["opening_not_set"],"officialObservation":null}]}
```

返回目录配置币种与已保存资金币种的并集，每币种单独一行。资金请求显式currency只需在supported_currencies，不依赖或回写目录币种偏好；本机已选但服务端尚无行的币种按cashRevision=0和unknown处理，首次写入后返回该行。未设置不是0。已知期初（包括明确0）设置后，opening为`{amount:number,asOf:ISO,basis:"new_external_opening"|"allocate_verified_unallocated_checkpoint"}`，balance为同币种有符号现金；complete表示该子账来源可计算，**不表示交易强制分账户余额**。状态为uninitialized/ready/incomplete/official_readonly；官方来源仍只读，officialObservation本次null，不能拿它宣称官方余额已同步。ready也返回unavailableReasons=[broker_buying_power_not_enforced]，available/reserved为null。

GET summary_path：`{userId,globalCashRevision,asOf,complete,byCurrency:[{currency,totalCash:number|null,cardCash:number|null,brokerCash:number,unallocatedCash:number|null,complete,unavailableReasons:string[]}]}`。totalCash与既有readAccountCash同源；fund现金=brokerCash+unallocatedCash，再加cardCash得到totalCash，仅为归属分解，不额外累加资产。缺源保持null，已初始化券商之外未分配金额仍是unallocated。

GET entries_path?currency=USD&limit=50&offset=0&snapshotRevision=…：limit 1..200，快照分页；返回snapshotRevision/pagination:{limit,offset,total}/items。item为`{id,operationId:string|null,brokerAccountId,currency,kind,amount,direction:1|-1,occurredAt,createdAt,note,sourceOrderId:string|null,balanceAfter:number|null}`。手工kind为opening/external_deposit/external_withdrawal，真实成交为trade_buy/trade_sell/trade_dividend。成交operationId目前null，sourceOrderId用于唯一对应原订单；逐笔余额按完整账本先计算再分页；发生时间、记录时间均相同且无可靠先后顺序的条目保持null，不用随机ID虚构顺序。无流水编辑/删除入口，已归属资金/成交不能被旧接口删除或改写财务字段；备注等非金融内容可按原接口受限处理。

## 期初及外部现金流

期初是时点现金，非持仓成本、总资产、累计收益或累计入金：

- allocate_verified_unallocated_checkpoint：从同币种已存在、可核对的未归属现金分配，券商增加、未归属减少，全局净变化0。
- new_external_opening：用户明确确认此前未录入的独立外部期初。仅当该币种没有任何手工资金、成交来源或已初始化券商子账时允许，一次性增加唯一opening来源，不是收益。已有现金来源不能借此重复增加期初。
- 期初时点不能跨越已有后续流水/成交，存在同币种待成交订单时拒绝；有复杂历史、未分配金额不足或需要补历史差额时40902，需要后续独立核对工具，不能调用总现金调整接口自动代办。保存期初不会重放/迁移旧成交扣款。分配checkpoint已覆盖的原总账资金/成交受数据库保护，旧接口不得删除改写或回填其覆盖时点以前的来源；订单缓存重建不受此影响。
- external_deposit / external_withdrawal：仅统计范围之外真实进出，分别增加/减少该券商及全局一次。本人卡包/其他券商转移不属于external，本次必须禁用这种转移入口。
- 外部现金流必须先有明确期初；occurredAt不得早于期初或该子账最新现金事件；回填更早时点须后续独立历史核对。出金须同时有券商余额及全局fund可用现金，不能借用卡包余额；待成交买入按实际金额含费用预留，合法OCO兄弟只取最大一条，其他独立委托相加；无法核对预留来源则不提供出金额度，不把未知补成0。

## 请求、预览及回执（固定shape）

```json
{"requestId":"小写UUID","action":"opening","brokerAccountId":"ba-…","currency":"USD","amount":1000,"occurredAt":"2026-10-18T08:00:00Z","note":"期初现金","globalCashRevision":"账户或总览读取的64hex","targets":[{"brokerAccountId":"ba-…","brokerRevision":3,"cashRevision":0}],"openingBasis":"allocate_verified_unallocated_checkpoint"}
```

三种action同一shape。opening必须带openingBasis，其余必须省略；targets恰好一个，与根brokerAccountId一致。amount有限、最多8位小数、0..1e12，仅opening可0。note必填字符串（可空），最多200字符；occurredAt必须是真实带时区ISO日期且非未来。cashRevision是该币种持久整数，未初始化0；brokerRevision取账户最新revision；globalCashRevision是覆盖本人总现金、订单及归属数据的hash。拒绝未知字段。

POST preview_path只读返回`{userId,action,currency,amount,occurredAt,globalCashRevision,targets,previewRevision,effects,globalEffect,externalFlow,canSubmit:true}`。effects每项`{kind:"broker"|"unallocated",id,currency,before:number|null,after:number,delta:number,cashRevision}`；分配期初包含未归属对向腿。globalEffect为该操作全局现金差额：分配期初0，新外部期初正数，external进出有符号金额；externalFlow只统计外部deposit/withdrawal，期初0。

POST submit_path提交同一请求+顶层previewRevision。最终IMMEDIATE事务核验本人/授权、账户与币种、所有版本和预览hash，再一次提交唯一fund来源、子账、流水和持久回执。UUID命名空间与原券商operations共享。提交成功返回现有API envelope，data内是回执：

```json
{"requestId":"UUID","accountId":"ba-…","kind":"cash_opening","state":"completed","code":0,"message":"ok","data":{"operationId":"UUID","userId":"owner","action":"opening","currency":"USD","amount":1000,"occurredAt":"ISO","globalCashRevision":"提交后64hex","targets":[],"previewRevision":"原确认hash","effects":[],"globalEffect":0,"externalFlow":0,"canSubmit":true,"snapshots":["账户最终读取模型"]},"completedAt":"ISO"}
```

例中的空数组只是shape说明，真实targets/effects/snapshots含本次账户。kind为cash_opening/cash_external_deposit/cash_external_withdrawal。失败回执state=failed/code/message/data=null。未知结果只按原UUID GET operation_path；重复UUID40901，不自动换UUID或重放。40902需重新读并展示差异，用户确认后才新请求。格式错误400可在回执前拒绝，授权失效401、scope403、外人/删除账户404、官方来源40903；确定性业务失败持久回执。内部未知故障整批回滚，不宣称已有成功回执。

## 交易来源与保护

初始化后新订单按已初始化的真实结算币种，在创建事务内以稳定orderID记录现金归属，成交时用orderCashAmount真实净额投影一次。原fund-order缓存可重建，不影响归属；港股通使用真实CNY净额，普通HKD及费用/股息保持原规则。之后记录改名、移出或关联其他券商不搬历史现金。期初前旧成交无归属，不自动迁移；期初禁止已有同币种待成交，避免把旧挂单暗中接入。

已归属成交财务字段和删除受数据库保护，不能旧接口重放历史或用REPLACE替换；待成交改单/观察仍按原规则，但不能改所属证券/币种或回填到期初之前。新订单早于该账户币种期初时点拒绝40902。此保护不改变其他未分账历史记录。

账户有期初/账本不能删除；币种已有期初或历史资金使用就算余额0也不能移除。官方来源现金写入拒绝，官方cash_json继续只核对、不入账。便携JSON不能保留资金覆盖及归属，已分账账户须用完整数据库备份恢复；导入导出均明确拒绝旧便携路径，防止只迁移金额丢失归属。无真实金额自动迁移，无自动恢复外部报表金额。

本次不支持卡包/券商划转、跨币种、复杂历史期初修复、流水冲正、官方现金核对UI、分账户强制交易现金或绩效收益率。相关UI保持禁用/不可用，不能以“资金系统已全量完成”描述。源代码更新不等于服务已部署；由用户手动更新服务器。

## 账本读取优化（可选 read_models v1）

本次在cash_ledger新增可选发现：`read_models:{version:1,entry_balance_after:true,activity_summary:true,withdrawal_capacity:true,statement_snapshot_scope:"broker_currency"}`。原version、写入字段及UUID回执不变，旧客户端可忽略附加响应字段，旧服务未发现时不要假设以下字段存在。

每个currencies行附加：

- `activity: {openingAmount:number,externalDeposits:number,externalWithdrawals:number,netExternalFlow:number,tradeNetFlow:number,entryCount:integer} | null`。仅统计该账户该币种的真实流水，期初不算外部净入金；tradeNetFlow含成交/股息真实净结算及费用。数据完整时balance=openingAmount+netExternalFlow+tradeNetFlow，缺少期初/来源时activity为null。金额不表示投资收益率。
- `withdrawalCapacity:{amount:number|null,reservedGlobalBuyCash:number|null,basis:"min_broker_balance_and_owner_fund_cash_after_reservations"}`。amount是当前允许外部出金的上限，取券商余额与本人同币种fund现金扣除委托预留后的较小值，已知负值取0；不借用卡包资金。官方、未初始化、资金或预留来源未知时amount为null。它与提交校验使用相同算法，**不代表购买力**；available/reserved仍为null、trading_enforced仍为false。

entries响应附加 `balancesComplete:boolean`，表示该页所属完整账本的逐笔余额都能确定；items[].balanceAfter可为真实数字。排序按发生时刻（解析时区）、期初优先、记录时刻、稳定ID。相同时刻且无法确定先后的非期初条目balanceAfter为null，但账户最终余额与activity仍可完整；不能用balancesComplete=false把已知账户余额误清成未知。发生来源缺失/金额或日期矛盾时账户balance/activity保持null，complete=false并返回cash_ledger_source_incomplete，出金不能继续。

流水分页snapshotRevision只覆盖本人该账户该币种的statement，其他账户资金变化、行情价格、图标及自动订单现金缓存重建不打断翻页；本账本条目变化仍40902。globalCashRevision仍覆盖所有真实现金、成交/委托和归属变化，但不包含重复的fund-order缓存、行情或券商图标。升级后hash算法变化可能使旧预览40902，客户端重新读取并预览，不自动重放。

资金转出与期初分配不再允许用1e-8容差透支最小单位；0余额不能出金0.00000001。币种开户只核对同币种历史和待成交，其他币种独立交易不会无故阻止开户。
