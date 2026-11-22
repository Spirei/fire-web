# Alcor App 原生账本 v2 合同

匿名 `GET /api/v2/auth/config` 中的 `native_ledger.version == 1` 声明以下能力。使用现有同源 App Bearer 和本人账户，无需第二套登录。读权限为 `portfolio.read`，写权限为 `portfolio.write`。所有响应沿用 `{code,message,data}` 信封。

接口默认关闭。隔离联调用 `ALCOR_NATIVE_LEDGER_ENABLED=1` 启用。App 的交易流程全部迁到原生事务并完成联调后才启用正式环境。

## 路径与来源版本

- `GET /api/v2/account-assets/native-ledger` 原子回读本人订单、持仓及原币现金。返回 `{ownerId,source,sourceRevision,legacyRevision,positions,cash,orders}`。`source` 为 `legacy` 或 `native`。未接管时 `sourceRevision=0`，`legacyRevision` 是服务端返回的不透明版本，取自本次只读快照。接管后每个已提交事务递增 `sourceRevision`，`legacyRevision=null`。
- `POST /api/v2/account-assets/native-ledger/transactions` 写入一个原子事务。首次成功及同本人、同 UUID 和同内容的重试都返回 HTTP 200 和原 `{ownerId,requestId,kind,sourceRevision}`。旧版本或不同内容复用 UUID 返回 HTTP 409。跨设备读到旧版本时先重新回读，保留本机未确认操作。
- `GET /api/v2/account-assets/native-ledger/transactions/{requestId}` 读取原回执，用于请求结果未知的恢复。已有回执返回 HTTP 200，本人尚无该回执返回 HTTP 404。他人编号同样为 404。操作重试须使用原 UUID 和同一内容。

日期须带时区。保留实际成交时间，录入时间仍单独记录。数量、价格、费用和余额采用普通十进制字符串。无来源依据的金额及单位成本为 `null`，缺少的币种等同未知，负余额合法。持仓编号为不透明字符串。

## 只读接管旧账户

读取 `source=legacy` 时，Fire 用当前手工实盘持仓和独立原币资金记录形成只读基线。已接入的券商以稳定编号标识，未归属记录也保留；官方和模拟账户使用原读接口。此前仅镜像存储的 App 订单和旧服务订单保留其原入口和身份。接管从这份已核对的持仓和现金开始，新账本只计接管后的事务。历史数据不会被重新计算或补成零。

确认接管时提交如下请求。服务端重新核对 `legacyRevision` 并以同事务保存所见的当前持仓和现金，无须 App 重传或覆盖旧数据。

```json
{
  "requestId": "e359fd55-b0de-459e-b3f0-a2f18ce169c0",
  "kind": "adopt",
  "baseRevision": 0,
  "legacyRevision": "<GET 返回的版本>"
}
```

已确认的接管回执返回 `sourceRevision: 1`。读旧基线不会创建账本，空账户也可接管。能完整核对的实盘在途委托保留原 UUID、最新条件和历史版本。接管事务同时保存移交凭证，使这些订单不再参与旧端执行、撤单和资金占用。旧委托抢先成交、撤回或修改时，接管凭证失效并须重新读取。无法完整表达的旧附加单或归属不明的旧单在 `adoptionBlockers` 返回编号和原因，接管返回 409，原委托仍由旧服务负责。

接管后旧客户端仍可读历史，生效值进入资产、记录、订单和交易周期读模型。旧日期缺少已核对的期初时，交易周期继续标为未知。

## 原生事务

下例是本人旧持仓 18 股、USD 现金已核实为 0 的基线上的补录。订单条目沿用现有 `native-orders` POST 形状。原生完成数量和现金变更并一起提交。Fire 校验基线版本、数量变更和结算一致性，保存原日期与原订单 UUID。新证券可直接提交，`quantityBefore` 为 `"0"`，入账时和订单一起创建。

```json
{
  "requestId": "fbd97509-c472-4aca-824c-fc2d6ee5c466",
  "kind": "trade",
  "baseRevision": 1,
  "orders": [{
    "tradeId": "8d9f8d01-db46-4a06-a93b-7c6066303708",
    "recordId": "known-record", "brokerAccountId": null,
    "market": "US", "code": "AAPL", "name": "苹果",
    "side": "buy", "status": "filled", "execution": "recorded",
    "quantity": "15", "price": "300", "fees": "1.05", "priceCurrency": "USD",
    "settlementCurrency": "USD", "settlementAmount": "4501.05",
    "orderType": "limit", "orderPrice": "300",
    "createdAt": "2026-11-23T06:00:00Z", "filledAt": "2026-10-28T22:50:00+08:00"
  }],
  "positions": [{
    "recordId": "known-record", "brokerAccountId": null, "market": "US", "code": "AAPL", "name": "苹果",
    "quantityBefore": "18", "quantityAfter": "33", "unitCostAfter": null
  }],
  "cash": [{"currency": "USD", "balanceBefore": "0", "balanceAfter": "-4501.05"}]
}
```

读回持仓使用 `{recordId,brokerAccountId,market,accountMarket,code,name,quantity,unitCost}`，现金使用 `{currency,brokerAccountId,balance}`，订单保留原条目及 `brokerAccountId`。`brokerAccountId` 是 Fire 本人券商账号的不透明编号，`null` 代表未绑定券商；名称仅供展示。有券商归属的持仓和订单均提交该字段；无归属时可省略或传 `null`。持仓的 `accountMarket` 可省略，默认证券市场；港股通确定真实账户市场时传 `CN`。

App 可按受影响币种提交本人全局 `cash`，省略 `brokerAccountId`。也可逐项提交已归属的原币余额及相应 `brokerAccountId`。Fire 根据订单的券商编号及实际结算验证差额，并在同一事务计算全局与券商余额。两类余额分别核对，余额未知时保持 `null`。响应中的 `brokerAccountId=null` 表示全局现金，其他行表示已归属券商的余额，两类读数无需相加。未知现金基线可接收原币成交变化但余额仍未知。

委托、撤单及未成交删除提交订单状态，并传空的 `positions`、`cash`。委托成交、手工成交编辑和已成交删除都提交受影响的股数及原币现金。删除项目作为墓碑保留在同步返回中，App 从可见订单剔除。多个同事务相关订单可一起提交，批内 UUID 各自唯一。

主单成交时，App 可在同一 `trade` 事务的 `orders` 数组一并创建附加委托。子单提交 `parentOrderId`、`startsAt`、`session`、`expiresAt`、`triggerPrice` 和 `triggerAbove`。子单成交时可在同一数组提交另一子单的 `cancelled` 状态，持仓和现金只提交实际成交的变动。报价、策略分支及联动时机由 App 判定，Fire 保存订单状态并核对整批账务和回执。

既有订单读接口以 `executionModel=app_native_ledger` 标识原生账本订单，`nativeActions` 宣告当前能否撤单、删除和编辑。订单变化提交到原生事务入口。旧同步入口仍可读取这些订单，同编号的修改由原生账本处理。

新原生委托、直接成交和合并后的汇总单由服务端分配十位订单编号。订单列表在 `orderNo` 返回编号，账本快照以 `orderNumbers[tradeId]` 返回同一编号。移交的委托保留原订单编号，改单、成交、撤单和删除沿用该编号。交易请求仍使用原 `tradeId` 和独立的 `requestId`，回执结构沿用原合同。

### 待成改单与版本历史

待成改单沿用 `kind=trade`，同编号、同证券、同券商、同创建时间，保留 `status=pending`，同时传更新后的委托条件及带时区的 `changedAt`。已成交股数和原币现金不受影响，`positions` 和 `cash` 传空数组。`expiresAt` 支持带时区绝对时间或交易所日历日期。`triggerAbove` 与 `triggerPrice` 一起表达触发方向和精确价格。若有实际变更时间，成交、撤单和删除也可提供 `changedAt`。

原生快照的 `orderHistory` 用订单 UUID 索引各版本，条目包含 `revision`、`occurredAt`、`status`、`quantity`、`price`、`orderPrice`、`fees`。新变更追加 `requestId` 和时间来源 `timeSource`，缺少设备实际时间时标记为服务器接收时间。

既有订单接口返回按时间倒序的 `orderActivity`。每行包含稳定的 `id`、带时区的 `timestamp`、`kind`、`quantity` 和 `price`。`kind` 可为 `submitted`、`amended`、`filled`、`cancelled` 或 `expired`，缺少数值依据时留空。补录的成交活动使用实际成交时间。已移交委托保留原展示编号，读回的 `nativeActions` 由原生事务执行。

### 合并已成交订单

使用同一个事务入口，发送 `{requestId,kind:"merge",baseRevision,orderIds,mergedOrderId,filledAt}`。原单须已成交、生效且同券商、同一持仓、同方向。选择任一原单的实际成交时间用于合并显示。原单以 `mergedIntoOrderId` 指向汇总单，汇总单以 `mergedFromOrderIds` 保留原单关系。精确成交总额 `grossAmount`、原币结算额和费用保留原账本金额，持仓和资金不重复入账。收益日历仍按各原单的实际成交日读取。

收益日历、趋势与成交标记读取 `GET /api/v2/account-assets/orders?scope=all&status=all&basis=financial`。App 可在 v2 认证发现的 `account_assets.features.financial_order_basis` 为布尔值 `true` 时使用。响应沿用订单列表信封，`data.basis` 为 `"financial"`，`items` 和 `count` 仅包含生效的已成交记录。原生汇总单展开为每笔原成交，保留原 `id`、`orderNo`、日期、股数、成交价、费用和结算。多次合并仍回到每笔实际成交。显式删除且未归入生效汇总的成交不会计入。`scope=today` 按原成交的市场本地日期筛选，也可按 `recordId` 查询。该视图用于分析，原生行的操作按钮全部关闭。省略 `basis` 时继续返回原订单展示列表及合并汇总单。

单次请求支持最多 100 个订单、100 条持仓变动和 100 条现金变动，并限制请求体为 512 KiB。此版本记录已有成交和委托生命周期，独立的现金入金、出金和对账命令需要单独协议。
