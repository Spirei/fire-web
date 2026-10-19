# 原生历史手续费更正 v1

2026-10-20，规则版本 `2026-10-20.1`。这是源码实现合同；实际服务须经用户更新后读取发现。本次未修改真实历史订单，也未推送手机。与券商官方账单导入、公开费率对照及分账户购买力分开。

## 发现与授权

同源 v1/v2 auth/config 的 `account_trading.historical_fee_repair`：version=1、supported=true、rule_version、providers=[longbridge,huatai]、max_selection=500、preview_max_age_seconds=600、automatic_zero_fee_repair=false、source=owner_reconstructed。按所选版本返回以下路径，不能客户端猜测路径或跨版本重试：

| 字段 | v2 路径 | 权限 |
| --- | --- | --- |
| snapshot_path | `/api/v2/account-assets/fee-repairs` | orders.read |
| preview_path | `/api/v2/account-assets/fee-repairs/preview` | orders.write |
| submit_path | `/api/v2/account-assets/fee-repairs/submissions` | orders.write |
| operation_path | `/api/v2/account-assets/operations/{requestId}` | portfolio.read |

仅 App Bearer，旧授权不自动扩权，不回落 Cookie。401/403、切换本人/来源/服务及后台切换时，客户端不得发布迟到预览或自动提交。结果未知只 GET 原 UUID；404 回执也不证明请求从未提交，不能自动 POST。

## 范围与来源

长桥 US 与华泰 CN 每次分别处理一个本人稳定 `brokerAccountId + providerId`；不按名称、币种或旧 `order.broker` 猜归属（旧导入确曾把币种写进 broker）。逐笔核对 `recordId`、当前关联、订单/记录版本以及历史实际券商归属，记录后来移入账户不自动证明历史归属。

新导入保存 `trade_fee_evidence` 的原始输入指纹与导入时账户信息，不追认旧行。新手工录入有明确来源，含本人登记的零费用，一律保留。原非零、API 成交费用、已更正费用保留。旧行没有输入证明时为人工核对项，不能默认勾选或用全选把 `legacyImportConfirmed` 填 true。只有本人逐笔确认“确属旧导入遗漏费用”后才允许规则重建；不会把这份确认变成官方导入证明。

证券类型与整笔计费也须本人核实，不能按代码猜 ETF、ADR 或基金。`wholeOrderConfirmed=true` 表示已核实该行代表一笔完整独立收费订单/交易日，无拆单合并、卡券、费用减免或额外费用（如 ADR、金融交易税、CAT、夜盘附加费）未处理，并接受当前规则所列的分项分币四舍五入。未知时为 false，单列排除。`brokerOwnershipConfirmed=true` 表示本人已核对该笔成交当时确属本次稳定券商账户，不能由“当前记录已关联”自动代填。

仅声明 `owner_reconstructed`，不声称券商实际已扣金额。官方管理账户只读；缺期初持仓成本、当前数量/成本不能与历史对平、同时间无法证明先后、港股/港股通/其他市场、分红、非成交、未知品种、碎股及不能确认的计费排除。被分配型现金期初 checkpoint 覆盖的旧成交保持原状，不能通过更正绕过覆盖核对，也不调期初或伪造外部入出金。

## 已核实监管区间与本人套餐

监管费率是收费机构的规则；传导给个人账户的最低额、分币舍入及优惠仍须本人核实。查询截至 2026-10-20，之后日期不自动沿用。具体来源同时随每笔 components 返回。

| 费用 | 支持区间与规则 | 依据 |
| --- | --- | --- |
| US SEC（卖） | 2025-05-14 至 2026-04-03：0；2026-04-04 起：成交额×0.0000206 | [SEC 2025 命令](https://www.sec.gov/files/rules/other/2025/34-102779.pdf)、[SEC 2026 公告](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2) |
| US TAF（卖） | 2025：0.000166/股、最高8.30；2026-01-01 至09-30：0.000195/股、最高9.79；2026-10-01 至12-31暂停（实现仅算到查询截止日） | [FINRA 费率表](https://www.finra.org/sites/default/files/2024-11/sr-finra-2024-019.pdf)、[暂停生效文件](https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf) |
| CN 过户费（双向） | 2022-04-29 起成交额×0.00001 | [上海市委金融办转载中国结算通知](https://jrj.sh.gov.cn/SCDT197/20220429/f715759a877b4158812eb6df70ccb49e.html) |
| CN 印花税（卖） | 支持的2022-04-29至2023-08-27：0.1%；2023-08-28起0.05% | [财政部税务总局2023年第39号公告](https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211343/content.html) |

SEC 官方区间以 charge date 为准。普通股票历史以交易所当地日期分类，在新费率切换附近的2026-04-02至04-04卖单须实际账单，不能套期权结算日解释股票；更早于2025-05-14的US记录暂不重建。TAF低价豁免边界也交实际账单核对。买单不加 SEC/TAF，暂停区间不强收最低0.01。

本次实现的两种**本人确认套餐**不是券商普遍报价或全历史默认值；个人须确认自己的适用起止日期，超出期间即排除：

- 长桥香港账户US整股、国内股票或ETF：佣金优惠0；固定平台费0.005美元/股、最低1、最高成交额0.99%（最低与上限冲突按最低）；交收0.003美元/股、最高成交额7%；有费率时卖出 SEC/TAF 最低0.01，按分项四舍五入到美分，汇总分项。当前官网地域/套餐与个人优惠可能不同，不拿[新加坡/新西兰公开表](https://longbridge.com/nz/support/topics/1dc1l7t/2udmwzz)替代用户截图中的香港套餐。官方[优惠说明](https://longbridge.com/hk/zh-HK/support/topics/28nggs8/8g1um4)也明确免佣不包含其他费用；不由公开优惠自动推断本人历史生效日期。
- 华泰大陆A股普通股票：佣金0.1154‰、最低5元；`commissionIncludesExchangeFees=true` 必须确认该个人报价包含经手费和证管费，避免重复收取。另计过户及卖出印花税，分项四舍五入到分。场内开基0.1‰不由代码猜测，本版单列待实际账单；也不能拿客服“万三”示例替代个人报价。

## 读取与确认

`GET snapshot_path?brokerAccountId=ba-…` 返回：

```
version,accountId,brokerAccountId,providerId,brokerRevision,snapshotRevision,
globalCashRevision,collectionRevision,ruleVersion,asOf,ordersComplete:true,
items:[{orderId,recordId,market,code,side,status,qty,price,amount,fees,tradedAt,
        revision,recordRevision,exclusion:string|null,
        importProof:"verified_input"|"unavailable",manualReviewRequired:boolean}],
unassignedOrderIds,supportedProviders,automaticZeroFeeRepair:false
```

items 包括当前该账户所有订单，明确未选/排除；未关联历史保持 unassigned，不能自动搬账户。全本人订单超过10000或版本覆盖不完整时整体失败，不截断并返回完整。

POST preview_path，严格字段：

```json
{
  "requestId":"00000000-0000-4000-8000-000000000001",
  "accountId":"本人userId",
  "brokerAccountId":"ba-稳定ID",
  "providerId":"longbridge",
  "brokerRevision":1,
  "snapshotRevision":"读取返回的64hex",
  "ruleVersion":"2026-10-20.1",
  "plan":{"effectiveFrom":"2025-09-01","effectiveThrough":"2026-10-20","confirmed":true},
  "orders":[{"orderId":"原ID","revision":1,"recordRevision":1,
    "instrumentKind":"us_domestic_equity","wholeOrderConfirmed":true,
    "brokerOwnershipConfirmed":true,"legacyImportConfirmed":true}]
}
```

huatai 的 plan 另须 commissionIncludesExchangeFees:true。instrumentKind 仅 us_domestic_equity/us_etf/cn_a_equity/unknown，必须符合本次市场。legacyImportConfirmed 仅针对无旧导入证明的人工核对，已有新导入证明时可省略；有明确手工/API/非零来源即使传true也不覆盖。

预览只读，返回 candidates（日期/证券/方向/数量/价格、oldFees/newFees/feeDelta/currency、importProof、source、components各项kind/amount/rate/basis/effectiveFrom/effectiveThrough/source），excluded（orderId/reason）、unselectedOrderIds、cashEffect、positionEffects、canSubmit、previewRevision、expiresAt。positionEffects包含recordId、beforeCost/afterCost与beforeRealizedPnl/afterRealizedPnl。未知不补0。

cashEffect 的 before/after/delta 是**本人fund现金**，不包含卡包；brokerBefore/brokerAfter可null，brokerDelta只影响原本已有稳定现金归属的成交，其他为unallocatedDelta，externalFlow恒0。券商余额是总账归属，不能另加到资产。手续费真实改变原订单净额，不能另建adjustment/deposit再次扣费。未初始化的券商余额维持null。

POST submit_path 原请求加 previewRevision。签名10分钟有效，绑定本人、全部请求字段/选择集合、完整本人订单/记录/券商/资金状态和结果，JSON字段顺序无关，多连接/重启共享签名密钥。事务内 IMMEDIATE 重新授权及CAS；只对已展示 candidates 更正，excluded 保持原状。选中且排除的行也受确认签名约束，不得客户端擅自删掉后沿用原预览。

同事务更新费用、审计来源、该记录完整已成交历史派生快照/经济盈亏、持仓成本、原订单现金缓存与原UUID回执。不会改订单数量、价格、方向、成交时间、记录归属或当前持仓数量；同证券API成交费用、条件单metadata和原操作回执保留，但必要派生成本和盈亏重算，版本随之递增。成功返回 kind=historical_fee_repair 的标准app_asset_operations回执，data含预览结果、最终版本与新snapshot。原生订单明细额外返回可选 feeProvenance:{source,operationId,detail}。

## 常规已成交订单与累计费用明细

`account_assets.order_fee_read_model` 显式声明 version=1、applies_to=orders_path、broker_account_id=recorded_history_or_null、fee_currency=listing_market、fee_source=true、fee_breakdown=owner_reconstructed_or_null。`GET /api/v{n}/account-assets/orders?scope=all&status=filled` 的每行新增以下字段（不等同资产快照内旧todayOrders）；均来自已保存的订单证据，不从参考费率表反算。旧服务缺少字段时保持原总费用展示，不能伪造分项。

| 字段 | 含义 |
| --- | --- |
| brokerAccountId | string或null；成交创建时稳定现金归属、费用更正时本人确认的历史账户、新手工录单时保存的账户，或原API提交目标。没有证据返回null，绝不从当前持仓账户、broker名字或币种猜测 |
| brokerAccountIdSource | cash_attribution_at_creation / fee_repair_owner_confirmation / recorded_order_entry / submission_target / unavailable |
| currentRecordBrokerAccountId | 当前身份一致的记录关联账户或null，专门与历史brokerAccountId区分；转账户不搬动旧成交归属 |
| feeSource | owner_reconstructed / owner_recorded / legacy_import_placeholder / unverified_legacy；placeholder的0不能视为官方确认免收 |
| feeCurrency | 上市市场原币或null；港股通费用仍HKD，真实settlementAmount是CNY净收支，不能再当一份费用 |
| feeBreakdown | 当前仅**经本人确认后存储的重建组成**数组，含kind/amount/currency/rate/basis/effectiveFrom/effectiveThrough/source；非重建记录或组成与总费用不符时null |
| feeBreakdownSource | owner_reconstructed / unavailable；本版从未声称返回broker_reported真实账单分项 |
| feeProvenance | 仅重建记录提供{source:owner_reconstructed,operationId,detail}，detail包含本人套餐期间、逐笔确认、原费/新费和保存的组成 |

`fees` 仍是原记录的实际保存总费用。iOS可按US/HK/CN/港股通(accountMarket=CN且market=HK)筛选并按feeCurrency分别小计。显示重建组成时应标为“按本人规则重建”，不能标作“官方账单实收”；其他行仅显示已登记总费用。没有稳定历史归属时仍可按本人recordId展示总费，券商名称显示未知，不能把USD/HKD/CNY当券商。完整分页/本人范围与重复ID核对继续遵守原订单合同。

原UUID再POST返回40901，确定性业务失败保存failed回执；中途数据库异常整体回滚，结果未知仍只查原UUID。预览失效、CAS、历史覆盖或现金差额冲突40902；官方只读40903，外人/不存在404，撤权401/403。完整数据库备份可保留证据和回执；含更正的账户拒绝旧JSON迁移，避免抹掉来源。旧接口不能删除/替换已更正订单或改其金融身份；备注与合法派生重算保持。

## 验收

临时SQLite `node tests/historical-fees.cjs` 覆盖日期/暂停窗口/最低上限、来源缺失与逐笔确认、明确零/非零/API保护、owner/官方/完整CAS、签名篡改过期及跨连接、缺期初/碎股/未知基金或ADR、checkpoint、现金一次归属及缓存重建、混合API历史派生、失败回滚、真实导入证明、v1/v2和原UUID恢复。不会用真实446笔订单试写。原生界面联调及真实账单费用核对独立验收，不以源码推送冒充历史已经修复。
