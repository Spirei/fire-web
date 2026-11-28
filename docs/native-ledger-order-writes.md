# App 订单写入

App 计算订单、持仓和原币资金变动。Fire 按当前本人账户核对证据、版本和变动，原子保存有效账本、审计事件和 UUID 回执。路径下文均相对于 `/api/v2/account-assets/native-ledger`。读写沿用同源 App Bearer，分别要求 `portfolio.read`、`portfolio.write`，信封为 `{code,message,data}`。

## 统一能力发现

`GET /api/v2/auth/config` 的 `native_ledger.version` 表示写入协议版本。`native_ledger.operations` 的字符串对应 POST `/transactions` 的 `kind`，当前值为 `["adopt","trade","merge","registered_void"]`。后续兼容操作直接追加到列表，App 忽略未知值。列表存在时，以它决定可用写入。列表缺失的旧服务沿用原有发现逻辑，其中 `registered_void_version=1` 可开启旧核销流程。Fire 暂时保留该字段供已安装的 App 0.2.591 读取。原生账本关闭时整个 `native_ledger` 缺失。

每个本人账户共享一个 `sourceRevision`。写入用它作 `baseRevision`，每次成功保存递增一次。订单历史的 `revision` 和封存期初版本各自用于核对审计依据。

## 已有写入路径

原生订单按 `executionModel=app_native_ledger` 和当时的 `nativeActions` 决定是否允许改单、撤单或删除。

| 订单或动作 | 请求及取证 |
| --- | --- |
| 新买入、卖出、历史补录 | `kind:"trade"`。补录用 `status:"filled"`、`execution:"recorded"`，提交实际 `filledAt` 和单独的 `createdAt`，保留原操作 UUID 和订单 `tradeId`。成交同时提交 `positions`、`cash`。 |
| 原生挂单、待成改单、撤单、过期 | `kind:"trade"`。沿用订单 `tradeId`，提交完整订单状态。待成改单保留原单身份并提交 `changedAt`。纯委托状态变动提交空的 `positions`、`cash`。 |
| 原生待成单转成交及附加单联动 | `kind:"trade"`。提交实际 `filledAt`、受影响的订单和状态，同批附上成交所影响的持仓和原币现金。 |
| 原生已成交改单、允许删除的原生订单 | `kind:"trade"`。已成交改单沿用同一 `tradeId` 并增补 `editHistory`。删除传 `status:"deleted"`、`deletedFrom` 和 `deletedAt`，已成交单提交全部账务影响，纯状态删除提交空数组。 |
| 原生已成交合并 | `kind:"merge"`，提交 `orderIds,mergedOrderId,filledAt`。已生效原单与实际成交日保留，财务视图按原成交计算一次。 |
| 可核对的旧在途委托 | 先提交 `kind:"adopt"`、`baseRevision:0` 和最新的 `legacyRevision`。查回执并回读原生快照后，用原 UUID 走 `trade`。如有 `adoptionBlockers`，保留原状态及人工处理入口。 |
| 已封存的迁入成交核销 | 确认能力发现支持 `registered_void` 后使用下节合同。 |

每个写入都使用独立的 `requestId`。回执 `data` 为 `{ownerId,requestId,kind,sourceRevision}`。若结果未知，先 GET `/transactions/{requestId}`。本人暂未查到回执时，以同一 UUID 和同一正文重试。确认返回 409 后回读最新快照和取证，用户重新确认后才创建新 UUID。接管是独立事务，接管前的预览与交易草稿须基于新快照重算。

## 迁入成交核销 V1

普通订单列表的 `registeredVoidCandidate:true` 可用于显示核销入口。以本次取证能否通过为准。对已接管的本人账本使用 `GET /registered-void?orderId=<原单ID>`，多笔重复传 `orderId`。最多 100 个唯一标识，标识为不透明字符串，最长 200 字符。

| 取证响应 `data` 字段 | 内容 |
| --- | --- |
| `ownerId,sourceRevision,sourceFingerprint` | 本人账户、预览版本、封存来源 SHA-256。 |
| `orders[]` | `id,recordId,brokerAccountId,market,accountMarket,code,currency,side,quantity,price,fees,orderNo,tradedAt`。 |
| `positions[]` | `recordId,brokerAccountId,market,accountMarket,name,code,quantityBefore,quantityDelta,unitCostBefore,unitCostAfter`。 |
| `cash[]` | `currency,balanceBefore,delta`，当前只调整本人汇总原币余额。缺证据的券商余额继续显示未知。 |

POST `/transactions` 时顶层使用以下六个字段。示例为虚构账户。数量和余额用十进制相加，成本沿用取证中的 `unitCostAfter`，可以是 `null`。

```json
{
  "requestId": "a167de70-ced8-44f5-8df0-2022f5546973",
  "kind": "registered_void",
  "baseRevision": 4,
  "registeredOrderIds": ["source-registered-sale"],
  "positions": [{
    "recordId": "record-a", "brokerAccountId": "broker-a", "market": "US", "accountMarket": "US",
    "code": "SYN", "name": "Synthetic security", "quantityBefore": "3", "quantityAfter": "5", "unitCostAfter": "10"
  }],
  "cash": [{"currency": "USD", "balanceBefore": "100", "balanceAfter": "52"}]
}
```

服务端提交时重新取证。V1 适用于已封存、实际结算有依据、各自从最新一笔起连续选中的本人成交。后续同持仓有效原生卖出可重放。后续原生买入、独立关联资金、父子单、旧更正链或依据不足均返回 409 并提供原因。旧系统的自动资金展示副本随原单隐藏。成功后回读原生账本及普通、财务订单列表。两种列表仅显示仍然有效的成交，封存原件和事务回执可审计。

## 迁入成交改单候选合同

实现后将 `registered_amend` 加入 `native_ledger.operations`。计划覆盖本人已接管、已有完整取证的单笔迁入买卖成交，可更正股数、成交价和费用。继续沿用原订单 ID、订单编号、方向、标的、券商账户、原币和原成交时间。App 在一次事务计算并提交替换及其影响。

### 取证

`GET /registered-amend?orderId=<原单ID>` 使用不透明原单 ID。成功返回下列 `data` 字段。

| 字段 | 内容 |
| --- | --- |
| `ownerId,sourceRevision` | 本人当前账本版本。 |
| `sourceRef` | `{orderId,sourceFingerprint,orderVersion}`。来源为已封存数据集的 SHA-256，`orderVersion` 为当前生效订单版本的不透明字符串。 |
| `evidenceDigest` | 服务端计算的 SHA-256，绑定本人、原单引用、账本版本、期初、历史及后续成交和后续资金依据。 |
| `original` | `{id,orderNo,recordId,brokerAccountId,market,accountMarket,code,name,side,tradedAt,quantity,price,fees,priceCurrency,settlementCurrency,settlementAmount}`。 |
| `replay` | `{positionBeforeOriginal,subsequentFills,positions,cash}`。`positionBeforeOriginal` 含 `quantity,unitCost`。`subsequentFills` 按有效成交顺序返回与 `original` 同形的复算依据。`positions` 含原生持仓身份、`quantityBefore,unitCostBefore`。`cash` 含受影响的 `currency,brokerAccountId,balanceBefore`。 |

金额、数量及成本用十进制字符串，未知用 `null`。V1 仅接受完整且可在单请求上限内交付的重放依据。未经核实的券商余额仍为未知。`subsequentFills` 覆盖首版可核对的后续同持仓卖出，无法完整证明的成本、关联资金、合并、旧更正或复杂后续成交返回取证冲突。

### 提交与回读

```json
{
  "requestId": "56e1181d-9ab0-4102-8fb6-804d85d65b0b",
  "kind": "registered_amend",
  "baseRevision": 4,
  "sourceRef": {
    "orderId": "source-registered-sale",
    "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "orderVersion": "opaque-order-version"
  },
  "evidenceDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "replacement": {"quantity": "1", "price": "24", "fees": "2", "settlementAmount": "22"},
  "positions": [{
    "recordId": "record-a", "brokerAccountId": "broker-a", "market": "US", "accountMarket": "US",
    "code": "SYN", "name": "Synthetic security", "quantityBefore": "3", "quantityAfter": "4", "unitCostAfter": "10"
  }],
  "cash": [{"currency": "USD", "balanceBefore": "100", "balanceAfter": "74"}]
}
```

Fire 在本人写锁下复核 `baseRevision`、`sourceRef`、`evidenceDigest`，按订单方向验证同币种实际结算，并核对全部持仓与现金。原件、改前改后值、证据摘要及回执与有效改单同事务保存。普通与财务订单按原单 ID、编号、实际成交日各投影一条生效记录。普通列表的 `registeredOrderVersion` 随有效改单变化，`registeredAmendCandidate:true` 指示可以尝试取证。回执沿用 `{ownerId,requestId,kind:"registered_amend",sourceRevision}`。失效、证据不足或影响冲突用 HTTP 409，并在新合同的 `data.reason` 提供 `stale_revision`、`source_changed`、`insufficient_evidence` 或 `inconsistent_effects`。旧事务的 409 信封保持现行形状。

## 其余来源的接入条件

以下操作均待实现，开放时各自在 `native_ledger.operations` 中公布。在旧版服务上，App 继续按原入口的账户权限和订单能力展示，已接管账户只走其已公布的原生能力。

| 订单来源 | 候选操作、取证和提交 |
| --- | --- |
| 迁入的 `imported_suspended` | GET `/registered-pending?orderId=…` 返回 `sourceRef,sourceRevision,evidenceDigest`、实盘委托归属、最后条件、有效期和历史版本。POST `kind:"registered_pending"` 加共同字段及 `disposition:"cancel"` 或 `"resume"`。恢复时传 App 复核后的完整 `order`，取证须确认旧系统无活跃同单或结算，保存原标识的移交关系。纯状态变更的 `positions,cash` 为空。 |
| 仅镜像保存的旧 App 订单、旧内部成交 | GET `/legacy-order-mutation?orderId=…` 返回 `sourceRef,sourceRevision,evidenceDigest,original,ledgerEffect,allowedActions`。POST `kind:"legacy_order_mutation"` 加共同字段及 `action:"amend"` 或 `"delete"`，改单附完整 `replacement`。取证确认订单是仅镜像、已计入还是已有原生版本，据此校验 `positions,cash`，防止重复记账。旧展示记录保留来源关系。 |
| 分红和其它现金类订单 | GET `/recorded-cash-order?orderId=…` 返回 `sourceRef,sourceRevision,evidenceDigest,original` 和已核实的现金凭证、原币和归属。POST `kind:"recorded_cash_order"` 加共同字段及 `action:"amend"` 或 `"delete"`，改单附 `replacement`。`cash` 仅提交实际影响的原币现金，`positions:[]`。现金流水有独立来源时须一起取证并由对应现金协议处理。 |

表中候选协议的共同提交字段为 `requestId,kind,baseRevision,sourceRef,evidenceDigest,positions,cash`，取证也须返回 `ownerId`。回执沿用 `{ownerId,requestId,kind,sourceRevision}`，提交冲突或未知结果沿用本文的恢复规则。分红新登记继续使用现有分红凭证接口。外部券商和公开账户只按原授权来源读取，用户实盘账本的 App 授权不授予外部券商交易权限。
