# 原生券商分账户资金合约草案 v1

状态：**后续完整方案，非当前可调用API；已实现最小范围以 native-broker-cash-contract.md 为准**。2026-10-18。客户端可据此制作界面和模型，必须按实际服务发现门控；不得把下列设计路径写成已支持的服务能力。当前 c5c28ff 的 buy_target 仍使用本人总币种现金，并非券商分账户购买力。

## 现状与不可跳过的联动

- `fund_transactions` 只有user_id/currency，没有稳定券商归属。全局手工期初、入金、出金和调整不能按group名称猜账户。
- `readFundBalances` 忽略 `fund-order-*` 缓存行，直接逐笔计算已成交trade_orders的真实净额；`syncOrderCashTransactions` 可删除并重建缓存行。因此现金归属不能只挂在缓存行，也不能把订单和缓存各算一次。
- `readAccountCash` 把上述全局余额和已持有卡包现金相加。`cardWallet` 的fundAccount=broker已通过card-link对向记账；新增卡包划转必须复用同一笔，不得再写第二份fund现金。
- `broker_statement_imports.cash_json` 仅为官方报表核对快照，当前从未入资金总账。声明“官方余额”不能把快照直接加到现有现金。
- c5c28ff 的买入目标虽按本人券商匹配证券，现金可用性仍按本人币种总账核对。单独加cash界面无法实现券商资金限制。

## 记账原则

唯一现金来源投影为现有手工fund分录、真实成交现金、卡包余额三部分，券商余额是其**归属投影**而非第四项资产。新增稳定归属事件/映射以(userId,brokerAccountId,currency)记录，不使用账户名称、机构providerId或默认币种合并。不得把broker余额再次加到accountTotals。全局同币种恒等式为：卡包现金 + 券商已归属现金 + 未归属fund现金；未知项导致complete=false及金额null，不能补0拼总和。

拟建不可变资金操作及双腿分录、账户币种期初checkpoint、真实来源归属表；分录引用稳定fund transaction ID、order ID或card history ID，并有唯一来源约束。订单资金归属在实际成交事务保存，后续记录改名、解绑、转券商均不把历史现金搬家。缓存重建不删除归属。无归属的历史资金/订单保持unallocated，自动初始化不分配、不补初始金额。

- **期初**是明确时点的现金checkpoint，非股票市值、累计入金或收益。设计v1仅允许从同一时点已验证的unallocated现金显式分配，增加券商期初的同时减少未归属，不增加全局资产。amount=0必须是用户明确确认的已知零；未设置仍为null。用户填日期采用带时区ISO时间，不能含糊为设备今天。
- 期初后只累计明确归属且未被checkpoint覆盖的来源事件，各来源最多一次。历史成交不因补期初而重放；必须保存覆盖边界/来源版本，已有覆盖事件不能再次扣款。回填日期若无法重建该时点来源、缺历史现金或与已覆盖成交重叠，拒绝opening_reconciliation_required，不能把“当前余额”倒算成历史期初。
- 缺少可验证未归属期初时，v1不允许直接增加一笔“期初”补洞；后续单独做有预览、明确差额及覆盖清单的全局期初核对能力。这是已知边界，不能使用现有API总现金reconcile端点自动代办。
- **外部入金/出金**明确指统计范围以外的真实现金流。仅一条资金来源分别增加/减少该券商与全局现金；不是收益。交易费、汇率换汇及融资不在v1新增范围。
- **本人券商间划转**同币种双腿原子借贷，全局净额0；来源余额不足拒绝，无单边成功。转入端不能冒充外部入金，转出端不能冒充外部出金。分账户视角可展示流入流出，全局现金流/绩效必须消除内部腿。
- **银行卡与券商**仅在卡包适配能力实际上线后启用：必须是本人已持有、币种已知、稳定卡ID，有卡侧CAS及余额校验；复用现有card-link账务且同事务更新卡面余额、历史和券商归属。适配前返回不支持，不能降级成external或让用户手填卡余额。
- **未归属现金转入**是已存在现金的归属分配，全球净额0，不是external deposit。除期初明确分配外的独立历史归属迁移不属v1自动功能。
- 官方持仓来源账户在设计v1资金写入一律只读40903。官方现金快照作为separate reconciliation显示日期、币种和差额，未验证不抵账；切回手动后重新核对版本，不自动灌入官方金额。

## 拟上线发现对象（当前禁止返回）

放在各v1/v2 auth/config的broker_accounts.cash_ledger；以下为最终设计字段，实际路径按所选API版本同源返回：

```json
{
  "version":1,"supported":true,
  "summary_path":"/api/v2/broker-accounts/cash",
  "account_path":"/api/v2/broker-accounts/{accountId}/cash",
  "entries_path":"/api/v2/broker-accounts/{accountId}/cash/entries",
  "preview_path":"/api/v2/broker-accounts/cash/preview",
  "submit_path":"/api/v2/broker-accounts/cash/submissions",
  "operation_path":"/api/v2/broker-accounts/operations/{requestId}",
  "read_scope":"portfolio.read","write_scope":"portfolio.write",
  "actions":["opening","external_deposit","external_withdrawal","transfer"],
  "transfer_counterparties":["broker"],
  "opening_basis":"allocate_verified_unallocated_checkpoint",
  "cash_basis":"single_global_ledger_attribution",
  "global_cash_revision_required":true,"preview_required":true,
  "trading_enforced":true,"automatic_mutation_replay":false,
  "cross_currency_transfer":false,"official_cash_auto_post":false
}
```

这是计划shape，非已实现配置。supported/trading_enforced须在交易、全局汇总和绩效适配全部通过后才可真；卡包端点额外在transfer_counterparties实际出现card后启用。旧服务无cash_ledger时隐藏或禁用保存与分账户购买力，不调用/account-assets/cash核对端点冒充此协议。v1/v2数据同源但路径分别发现；不新授scope、不借用Cookie、不用用户ID代替券商ID。

## 页面读取模型

`GET account_path` 返回：

```json
{
  "userId":"owner","brokerAccountId":"ba-…","brokerRevision":3,
  "globalCashRevision":"opaque-global-hash","snapshotRevision":"opaque-account-cash-hash",
  "holdingSource":"manual","asOf":"2026-10-18T08:00:00Z",
  "currencies":[{
    "currency":"USD","cashRevision":0,"state":"uninitialized",
    "opening":null,"balance":null,"available":null,"reserved":null,
    "complete":false,"unavailableReasons":["opening_not_set"],
    "officialObservation":null
  }]
}
```

每个已选币种均有行。state为uninitialized/ready/incomplete/official_readonly；cashRevision为持久单调整数，未初始化0。ready的opening为`{amount:number,asOf:string,basis:"allocated_unassigned",checkpointId:string}`，balance/available/reserved为有限数值；非完整来源均为null，允许明确的已知0。available扣除该账户同币种真实待成交订单/OCO保留额，不根据其他券商剩余钱补足。officialObservation为null或`{amount:number,currency:string,asOf:string,source:"official_statement",difference:number|null}`，不作为balance第二来源。

`GET summary_path` 返回userId/globalCashRevision/asOf/complete、`byCurrency:[{currency,totalCash:number|null,cardCash:number|null,brokerCash:number|null,unallocatedCash:number|null,complete:boolean,unavailableReasons:string[]}]`。totalCash从唯一总账来，不相加局部不完整值；券商各行和未归属金额只是同一总额的归属分解。

`GET entries_path?currency=USD&limit=50&offset=0&snapshotRevision=…` 上限200、快照分页；返回snapshotRevision/pagination/items。item字段为`id,operationId,brokerAccountId,currency,kind,amount,direction,occurredAt,createdAt,note,counterparty,sourceOrderId,balanceAfter`；counterparty含kind和本人稳定ID或external，无银行卡号/密钥。balanceAfter无可靠覆盖时null。kind区分opening、external_deposit、external_withdrawal、transfer_in/out、trade_buy/sell/dividend；显示不等于全局绩效分类。v1流水不提供随意编辑/删除，纠错走后续显式冲正，禁止抹历史。

## 预览与提交请求

共同字段：`requestId`小写UUID、`action`、`currency`、`amount`（有限、非负、最多8位小数、上限1e12；只有opening可0）、`occurredAt`明确ISO时间且非未来、`note`最多200字、`globalCashRevision`、`targets`。

- targets为1或2个`{brokerAccountId,brokerRevision,cashRevision}`，无重复；账户须本人存在，currency在已选集合。
- opening / external_deposit / external_withdrawal另含`brokerAccountId`，恰好对应一个target。
- transfer含`from:{kind:"broker",id}`和`to:{kind:"broker",id}`，恰好对应两个target，不允许同账户；银行卡适配前不能传card，unallocated不能伪装broker。
- opening还含`openingBasis:"allocate_verified_unallocated_checkpoint"`，并以全局及账户资金版本校验期初时点分配及覆盖清单。
- preview返回`{userId,action,currency,amount,occurredAt,globalCashRevision,targets,previewRevision,effects,globalEffect,externalFlow,canSubmit:true}`。effects为每个受影响对象`{kind,id,currency,before:number|null,after:number|null,delta:number,cashRevision}`；期初包含unallocated对向效果。globalEffect为真实全局现金变化，externalFlow仅外部进出有符号金额，内部流动均0；无法核对直接失败，不能返回可提交的未知余额。
- submit沿原请求增加`previewRevision`。IMMEDIATE事务内重新授权、唯一UUID、所有账户及全局资金CAS、预览覆盖/目标核对、余额和全部双腿变化、全局投影、来源映射和回执一并提交。预览只读，不保留半成品。
- receipt与既有券商operations使用同一本人UUID命名空间；kind为cash_opening/cash_external_deposit/cash_external_withdrawal/cash_transfer。成功data为`{operationId,action,currency,amount,occurredAt,effects,globalEffect,externalFlow,snapshots,globalCashRevision}`，snapshots是受影响账户最终读取模型。失败state=failed/code/message/data=null。超时仅按原UUID GET回执，不自动补第二腿或新UUID重试。

400格式/超限，401失效，403scope，404外人/删除账户（不泄露身份），40901 UUID已用，40902版本/覆盖冲突/余额不足/期初待核对，40903官方来源只读，429限流。结构错误可在回执前拒绝；已接受UUID的确定性业务失败必须持久化。客户端对40902重新读、展示差异，用户重新确认后才用新UUID。

## 交易与旧路径的上线条件

1. buy_target发现新增独立 `cash_basis:"broker_currency_ledger"` 才表示券商现金执行；旧c5c28ff没有此字段，始终是全局现金口径。分账交易请求未来额外携带`brokerCashRevision`与`globalCashRevision`，预览返回对应broker/currency/before/after/reserved/revision，提交在原事务内重核，尚未冻结交易具体扩展字段，不让客户端提前发送。
2. 成交现金按orderCashAmount及真实settlement_currency/amount计入唯一来源，港股通CNY、普通HKD、费用和股息保持。待成交仅保留额，实际观察成交才落现金分录，OCO一份保留；不能另加fund流水造成总现金二次扣减。
3. 已分账账户不允许旧recordId交易、Web旧订单、修改/删除/重放历史、备份导入等绕过分账校验：适配同一服务或显式拒绝，不能默默回落到全局余额。保留旧UUID回执及同一版本快照，不因为查GET自动补账。
4. 交易、现金条目、余额变更都递增对应资金版本；未来回填在影响范围内重核覆盖及余额，不能只改显示数字。币种移除只要有期初、任意历史流水/保留额/官方未核对来源即拒绝，不能以余额0判定安全；有账本账户删除受引用保护。
5. 内部划转与期初不计收益或外部净入金。既有fundSummaries会把deposit/withdrawal计现金流，须识别新语义并消除内部腿后才启用资金写能力；收益率和历史绩效缺可靠期初/时序时标不可用，不猜收益。旧现金及负债保持原值，不迁移归属。

## 分阶段交付

A（本次）：代码证据与协议冻结；无运行时接口、无新发现、无真实资金变更。

B：实现唯一来源映射、独立只读投影/期初覆盖核验、UUID/CAS及临时数据库回归；仍不宣布完整资金写能力。缺期初和旧未分配金额保持未知或unallocated。

C：实现外部进出/券商双腿/期初分配及全局汇总、绩效分类、币种删除保护，与买入预览/成交/待成交/旧Web和备份写路径一并适配；验证全局不重复、无重扣后才启用cash_ledger与交易分账发现。卡包未适配时不声明card。

D：卡包双向原子适配、显式历史期初核对和冲正工具、官方现金核对流程。分别发现，不把后续缺口说成现有能力。

验收须在临时数据库覆盖：已知零/未知、跨币种隔离、历史成交checkpoint边界、外部流/内部流绩效、卡包与总账不双算、原UUID恢复、跨用户/撤权、双腿中途故障全回滚、多连接余额并发、买卖/费用/股息/港股通、挂单/OCO/改单、官方只读、币种删除、旧订单修改/导入备份/重建缓存与重启。真实实例只读，不用真实资金试账。
