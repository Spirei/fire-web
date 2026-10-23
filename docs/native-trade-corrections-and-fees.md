# 原生交易费用分项与成交更正 v1

2026-10-24。源码实现合同；具体上线状态以镜像提交及服务发现为准，不代表真实订单已更正。部署仍由用户操作，业务写入只在临时数据库验收。

## 成交更正：App 0.2.386 交接的协议差异

`account_trading.corrections` 可选发现，缺字段继续禁用写入口。v1/v2分别返回自己的同源固定路径：

```json
{
  "version":1,
  "preview_path":"/api/v2/account-assets/trading/corrections/preview",
  "submit_path":"/api/v2/account-assets/trading/corrections",
  "operation_path":"/api/v2/account-assets/operations/{requestId}",
  "actions":["amend","merge","delete"],
  "atomic":true,"preserves_originals":true,"replays_following_orders":true,
  "preview_revision_required":true,"preview_max_age_seconds":600,
  "idempotency":"same-request-original-receipt",
  "stock_connect":false,"attached_orders":false
}
```

特别注意：**原回执路径没有`/trading/operations`这一层**，沿实际已有account-assets/operations。preview/submit均仅App Bearer与orders.write；回执GET沿portfolio.read，不借用Cookie、不扩充旧grant。

请求沿交接：requestId小写UUID、accountId、tradingSnapshot返回的snapshotRevision、recordId/recordRevision、action、orders:[{id,revision}]；非删除含replacement:{qty,price,fees,tradedAt}，删除不接受replacement；merge另含timeSourceOrderId。非删除replacement可选feeInput，结构见下文。

合并2–100笔；修改/删除恰1笔。只支持同本人、同记录、同证券、同稳定历史券商、同方向的已成交买卖。不能把当前record关联用作缺失历史归属的替代证明。记录需手动来源且市场US/HK/CN；港股通、跨账户或结算冲突、带附加单的主单/子单、同证券待成交、未知期初或历史顺序、不守恒重放全部拒绝。非所选记录同币种的待买占用也会核验。

合并严格核对总数量及本金守恒，不对加权均价舍入后强行通过；tradedAt必须与timeSourceOrderId原单**字符串相同**。修改可以更正数量/价格/费用/时间，但不改证券、方向或历史账户。不会按默认费率静默替换fees；不带feeInput的费用始终是用户明确输入。

Preview POST只读，返回`request`原请求完整回显（不含previewRevision）、currency、cashBefore/cashAfter/cashDelta、quantityBefore/After、costBefore/After、realizedBefore/After、feeBefore/After、feeSource/feeDetail、affectedOrderCount、canSubmit、brokerAccountId、preservesOriginals，以及新增必需：

- previewRevision：`13位epoch毫秒.64hexHMAC`；签名绑定UUID、全部输入、结果和完整账户/订单/资金状态，不能拼接或跨UUID沿用。
- expiresAt：ISO UTC，10分钟。App本地可先阻止过期；服务端仍重新验证。

Submit POST沿原请求**额外回传previewRevision**。只有显式用户确认后提交；网络未知不重发，也不因回执404自动重发。预览过期/CAS冲突用新读取、新UUID和重新确认生成新预览。相同UUID且相同请求返回原回执（即使后来账本变化）；UUID用于不同内容返回40901。旧交易操作UUID不能被更正复用。

成功`kind=correct_trade`、state=completed，data:{snapshot,items,preview}。snapshot含accountId/snapshotRevision和最终现金/持仓/订单；items非空，含所选原单墓碑、非删除时替换单及重放历史。业务失败state=failed/data=null保存原UUID回执；初次请求按对应HTTP错误返回，再次原UUID相同请求可读取原failed结果，客户端必须检查state，不能把HTTP200视为更正成功。

### 实际事务及原始链

同一个IMMEDIATE事务：授权/CAS/签名→原始订单、metadata、费用来源/快照、历史费用修复记录和现金链接归档→原单标cancelled且显示“已由更正凭证替代”→生成一个替换单（删除不生成）→按时间重放全部后续成交快照及移动平均经济盈亏→更新当前持仓数量/摊薄成本→只同步原单/替换单现金净差→保存原UUID回执。任何中间失败回滚所有内容。

原单不物理删除，保留原ID、原金融值、原操作回执；trade_correction_originals保存原始完整行及证据，trade_correction_replacements形成后继链。常规订单读取额外返回可选correction:{state:superseded,operationId,replacementId}或{state:replacement,operationId}，当前成交总量/费用/现金只统计filled。删除的墓碑replacementId=null。

旧现金链接保留，不按当前记录转账户。若所有所选原单确有同一券商/币种现金归属，替换单继承一次；原单全部未归属则替换单仍未归属，混合归属拒绝。被分配型期初checkpoint覆盖的历史不能更正，替换时间不能早于已初始化资金期初。无新增外部入出金、无本金再次买入。

每个替换单都在同一事务中保存本次确认的独立费用快照，包含经原单证据核实的稳定券商账户、提供方、账户版本、币种和总费。旧App不带`feeInput`时，保存为`owner_recorded`，明确填0仍为已确认的零；分项、规则版本和规则快照保持null，不复制原单的重构费率或自动计算来源。原请求回显不增加`feeInput`，旧版响应继续适配原读取协议。无现金链接时也保存该快照，但不会新建现金归属；替换单可继续按新的预览和确认进行更正，前一次证据及原回执保留不变。

原API回执及附加单metadata不重写；普通无附加单API成交可以作为所选目标，同记录后续普通API成交仅重算派生值。旧update/delete历史接口继续拒绝含API历史或更正链的记录，SQL保护原单/替换单/已成交费用快照的金融字段，不删除历史锁。完整数据库备份才能保留这些证据，旧JSON迁移明确拒绝相关账户。

## 费用来源、分项及历史规则

可选`account_trading.fee_details`发现：version=1、request_field=feeInput、sources=[owner_recorded,rule_calculated]、rule_version=2026-10-23.1、providers=[longbridge,huatai]、calculated_modes=[record]、calculated_attachments=false、monthly_tiers=false、rule_snapshot=immutable_per_fill、personal_plan=owner_confirmed_request_snapshot、broker_reported=false。

### 旧App兼容与显式格式协商（最终约定）

发现另含 `header:"X-Alcor-Trade-Fees"`、`header_value:"details-v1"`、`read_model_version:2`。新App必须先支持v2费用读取结构，再给交易预览/提交、更正、订单/trading读取和原UUID回执GET统一带 `X-Alcor-Trade-Fees: details-v1`。响应回显同名头并Vary该头。未知头值400；带feeInput却未协商的写请求在事务前400，不保存费用或回执。

**无此头完全保持旧v1订单费用模型**：rule_calculated在HTTP展示层按已登记owner_recorded总额返回；新保存的手工/规则分项不塞进旧feeBreakdown（返回null/unavailable），recorded_fee_snapshot来源兼容成recorded_order_entry，规则快照不放进旧字段。旧历史owner_reconstructed七类结构保留。原总费用、现金和回执ID不变，旧App不会因未知枚举或分项缺字段导致整批读取失败。`account_assets.order_fee_read_model`原v1发现对象保持，不能仅因服务器存在新费用数据就用新模型解旧响应。

上述转换只影响HTTP表示，不改数据库内保存的规范回执与规则快照。新App带头后可读到完整来源、原币分项和规则历史。GET原回执也必须带相同协商头，不能在超时恢复时落回旧来源模型。旧App的owner_recorded总额仍表示本人账本已登记金额，不能解释为券商实际收费凭据。

保持旧顶层fees数值字段；没带feeInput仍按原合同登记owner_recorded，不自动把旧App默认的0改成费用。历史legacy_import_placeholder/unverified_legacy的来源区分保持，不把它们升级成明确用户零；独立历史修复仍须原预览及确认。

### 新交易及替换单的feeInput

普通实际成交在原交易请求新增可选feeInput；更正时放replacement.feeInput。服务端按稳定账户、provider、实际上市市场与成交当地日独立重算，要求总额精确相等，不信任手机给出的“已计算”结论。示例为合成账号标识：

```json
{
  "source":"rule_calculated",
  "brokerAccountId":"ba-111111111111111111111111",
  "providerId":"huatai","confirmed":true,
  "ruleVersion":"2026-10-23.1","instrumentKind":"cn_a_equity",
  "plan":{"id":"个人方案ID（可省略）","revision":1,
    "effectiveFrom":"2025-07-01","effectiveThrough":"2026-10-23",
    "overrides":{"commission":{"basis":"permille","rate":"0.1154","minimum":"5"}}}
}
```

plan.id与revision同时出现或同时省略。plan为本人明确确认的当前请求快照，**尚无服务端个人方案CRUD/云同步**；App原本地方案不会自动迁移。服务端保存该成交实际采用的完整个人期间/覆盖、解析后的默认规则、引擎版本、分类和舍入方式，未来修改本机个人方案不影响历史。confirmed表示已核对本人套餐、证券类别在该历史日适用及其他未建模费用（ADR/特别税费/夜盘等）不适用；不能用此来源声称券商实收。

instrumentKind仅us_domestic_equity/us_etf/cn_a_equity/cn_fund/hk_equity/hk_etf，未知不补0，不能按证券代码前缀猜基金、ETF或ADR。若当前声明类型明确且与输入冲突则拒绝；不自动写入新的证券声明。四个费用市场由稳定记录及实际渠道决定：长桥US/HK、华泰CN/港股通，错误组合拒绝。

overrides仅commission/platform/fundCommission，逐项覆盖默认。每个规则支持basis=free/percent/permille/share/order、rate、minimum、maximum、maximumPercent、minimumWins（默认true）、side=both/buy/sell（默认both）。十进制字段可数值或十进制字符串，最多8位小数，单值不超过1e12；百分比≤100、千分比≤1000；free不接受费率/上下限。非空tiers（月阶梯）没有完整月序列证明时拒绝，不能把月累计当0。期权contract和其他未知规则暂不启用。

手工分项可用：`{source:owner_recorded,brokerAccountId,providerId,confirmed:true,components:[{kind,amount,currency}]}`。components可省略；提供则最多20项、kind不重复、原币一致、合计与顶层fees精确相等。手工来源不带规则版本/证券类别/plan。明确手填0保留，不会被规则再覆盖。实际券商单据分项本版尚无broker_reported来源。

### 精度、默认值和核对范围

费用引擎使用BigInt有理数运算（无新增依赖），逐分项按两位half-up，再精确合计；HK股票印花税先向上到整元。原始数量/价格/费用输入仍至多8位小数。未知、未支持历史或冲突返回错误，不用0顶替。

- 华泰CN普通股票：本人确认的0.1154‰、最低5元（含经手/证管费用的个人报价），另过户0.001%、卖出印花税0.05%。已确认cn_fund采用0.1‰最低5，免股票过户与印花税；不能从代码猜。测试3000×11.99=35970，分项5+0.36=5.36；2700与300两单分别5.32和5.04。这些是规则向量，不是实收凭据。
- 长桥US：免佣、整股固定平台0.005/股最低1/上限成交额0.99%（最低优先）；交收0.003/股、上限7%。小于1股的App参考模板采用平台成交额0.99%最高0.99、无交收，1.25股仍按普通规则。此模板须本人确认；不同地区官网（例如[新西兰规则](https://longbridge.com/nz/zh-CN/support/topics/us-trade/fractional_shares)为1.2%）并不相同，不宣称该模板是所有地区历史官价。个人覆盖优先。
- US卖出SEC：[2025归零](https://www.sec.gov/files/rules/other/2025/34-102779.pdf)和[2026-04-04起20.60/百万](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2)；切换附近2026-04-02至04-04须实际账单，不由成交日猜charge date。TAF按[历史表](https://www.finra.org/sites/default/files/2024-11/sr-finra-2024-019.pdf)2025每股0.000166最高8.30、2026每股0.000195最高9.79，[2026第四季度暂停](https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf)；暂停不收最低0.01。低价TAF特例须实际核对。
- HK：长桥本人模板佣金免、平台15；华泰港股通公示0.3%仅为本人可改模板。普通股票印花0.1%向上整元，已明确合资格hk_etf按[IRD ETF豁免](https://www.ird.gov.hk/eng/faq/ETFs.htm)为0；交易费0.00565%、SFC0.0027%、AFRC0.00015%、交收0.0042%，见[HKEX费用](https://www.hkex.com.hk/Services/Rules-and-Forms-and-Fees/Fees/Securities-%28Hong-Kong%29/Trading/Transaction?sc_lang=en)及[2025交收调整](https://www.hkex.com.hk/News/Market-Communications/2025/250221news?sc_lang=en)。不硬编码任何证券的个人账户归属。

本引擎支持核对日2025-07-01至2026-10-23并受plan期间约束；超出不自动沿用。股息、ADR、其他特别费用、未支持券商/品种、月阶梯、自动委托或附加单费用须手工实际登记。港股通仅允许新实际成交的费用快照，HKD费用和实际CNY结算净额独立，现金不重复扣HKD费用；港股通更正本次未启用。

### 保存和读取

trade_fee_details保存每笔成交input及detail；未成交改单改变来源时，旧快照先归档trade_fee_detail_history，再保存新来源。已成交费用快照的金融值受到SQL保护，只有本更正协议以独立替换单更正；原快照不覆盖。

常规`account-assets/orders`/trading快照读取：feeSource为owner_recorded或rule_calculated，feeBreakdown为已保存components或null，feeBreakdownSource同来源，feeRuleVersion/feeRuleSnapshot为规则历史或null；brokerAccountIdSource=recorded_fee_snapshot表示保存费用时确认的稳定账户。旧owner_reconstructed/placeholder/unverified_legacy字段保持，旧缺来源也不升级成broker_reported。

## 验收与待原生协调

`tests/trade-corrections-fees.cjs`使用临时SQLite，验证：移植费用向量、个人覆盖、分项精度、错误总额拒绝、手工零优先、规则快照保存、原单链/墓碑、修改/合并/删除、所选时间及本金守恒、后续卖出/股息重放、资金归属只算一次、现金checkpoint/官方/附加单/跨本人及缺基线保护、完整CAS/签名过期、原UUID与并发、各阶段故障回滚、v1/v2权限及撤权。

App必须接previewRevision回传、过期和failed回执状态判断，回执GET修正为实际路径；额外费用输入须按fee_details发现接入。0.2.386旧总费用提交仍兼容，其分项不会自动变成已保存服务端分项。此合同不表示已完成真实手机往返验收。

世纪华通那两笔真实订单本次未读写；精确本人记录/原单标识只保留原生交接和本地私有说明，不写入公开协议。实际服务更新后仍需原生按最新本人快照解析完整两笔内部ID、预览并由用户确认，才能执行真实合并。时间取300股原单，不另买3000，不按默认模板冒称实收。

## 补充：摊薄成本差额不等于遗漏手续费

当前`tradeAccounting`的摊薄成本在买入时加入买入费用，卖出按回款冲减剩余成本；卖出费用进入经济盈亏，不再重复加到剩余成本。`portfolioLedger.replayEconomicOrders`另按移动平均成本及全部已登记费用核算经济盈亏。因此，当前qty×dilutedCost与一个选定窗口的买入额减卖出额，不是天然相等的两种数值；还需核对期初持仓/成本、完整时间范围、股息、调整/公司行动以及逐单舍入。数量净额相等也不能证明期初成本为零。

无论该差额大小，都不能反推成“漏记手续费”并写回。当前更正会先用真实期初/已登记费用重放原历史，再比对当前数量和三位摊薄成本；未对平返回冲突、不修改真实数据。只读参考费用单列估算，不进入原已登记盈亏或现金。原生若显示累计经济盈亏，必须保留历史完整性/成本未知的状态，不能把估算或原占位零升级成实际费用。
