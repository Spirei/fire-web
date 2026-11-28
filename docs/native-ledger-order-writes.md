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

每个写入都使用独立的 `requestId`。回执 `data` 为 `{ownerId,requestId,kind,sourceRevision}`。若结果未知，先 GET `/transactions/{requestId}`，关闭原生写入期间也可查询。回执明确缺失时返回 HTTP 404 和业务码 `40401`。App 确认写入能力、账户和版本后，以同一 UUID 和同一正文重试。确认返回 409 后回读最新快照和取证，用户重新确认后才创建新 UUID。接管是独立事务，接管前的预览与交易草稿须基于新快照重算。

### 换机与账号隔离

账号同步以 Fire 已提交账本为恢复来源。新设备登录同一账号后，从快照回读 `ownerId,sourceRevision,orders,positions,cash`，并可按原 `requestId` 取回回执。本机保存也使用同一订单规则，数据存入本机并独立备份。新登录的账号从其本人的数据开始，本机历史只经明确的导入操作处理。

App 按服务实例和当前 `ownerId` 存放待提交请求，发送时带已捕获的 `X-Alcor-Expected-Account`，并核对返回本人的 `ownerId`。Fire 以 Bearer 确定本人。若期望账号不同，返回 403 和 `X-Alcor-Retire-Context:true`。撤销设备凭据后，旧设备的读取、写入和回执恢复须重新取得授权。接管、批量更正和日常同步沿用同一账号边界。

验收使用隔离账户和两份设备会话。设备 A 成交后，无旧缓存的设备 B 登录同一账户并核对订单、股数、原币余额、版本及原 UUID 回执。换新账号核对空账本和跨账户回执隔离，再尝试发送旧账户的排队写入与已撤销设备请求，两个账户的已提交状态均须可复查。

### 响应失败与重试

| 结果 | App 行为 |
| --- | --- |
| 读请求不可达、超时或返回 5xx | 继续使用同一账号上次已核对的完整快照，标记同步已延迟。后台恢复读取，草稿编辑与已保存浏览独立。空响应、残缺资料和迟到的旧版本均不覆盖上次快照。切账号时从新账号的已确认数据读取。 |
| 已发出的写请求超时或连接中断 | 保留原 `requestId`、本人和完整正文。后台优先查原回执。若回执仍为 404，稍后用同 UUID 和同正文重试。收到回执后刷新账本，再处理依赖这次提交的写入。 |
| 409 | 核对原回执和实际版本。当前快照与请求 `baseRevision` 不符时先重新取证，按用户确认的当前资料构造新操作。已经提交的 UUID 或不同正文共用同一 UUID 时读取原回执核对。 |
| 401、403 | 停止此会话的自动重试。登录、授权或账号切换完成后，只恢复该账号自己的待办。 |
| 429、503 | 等待 `Retry-After` 或使用有上限的退避。以 HTTP 状态识别忙碌，沿用既有 JSON 错误码。订单、自选、费率写入触及限流时，返回 60 秒的重试间隔。 |

Fire 对同一账号写入加锁，以 `sourceRevision` 防止乱序覆盖。同一事务写入订单、持仓、原币余额、审计和回执。快照和回执读取使用已提交的数据版本，可与同账号订单写入并行。已有回执的同 UUID 重试也无需等待正在提交的业务事务。接管预览只读入账余额，挂单冻结和提现额度由各自入口核算。现有 PG 连接池等待上限为 3 秒，锁等待为 2 秒，单条 SQL 为 5 秒。资源超出边界时返回 HTTP 503 和 `Retry-After: 3`，App 仍需为后台同步连接和响应设置时限。

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

上面的历史改单用于已接管账户内尚未转成原生订单的迁入成交。其余旧来源按下文接管为原生订单，再使用统一的订单写入。分红继续关联独立现金凭证，核对其真实原币入账和归属。外部券商和公开账户按原授权来源读取。

## 已接管账户的旧订单状态

普通订单列表同时返回来源和状态。灰锁只表示本次操作无法直接执行。App 用实际行的来源、状态和取证结果显示原因。

| 订单来源与状态 | 持仓、现金和可核对操作 |
| --- | --- |
| `app_native_ledger` | 已成交单的变动记录在本人原生账本。挂单、撤单、过期只改变订单状态。按当前 `nativeActions` 提交原生操作，成交删除仍须核对受影响的持仓、现金、关联合并和子单。 |
| `source_registered_history` + `filled` | 这是已封存的原始成交。若封存现金账已证实完整，买卖纳入对应本人原币登记余额。每单是否构成接管时持仓、原币及成本的可逆变动，须以原件和实际核销预览复核。迁移映射的券商编号并不证明券商现金有入账。只有 `registeredVoidCandidate:true` 且本次预览通过时可核销。 |
| `source_registered_history` + `imported_suspended` | 原档状态为待成，Fire 当前将其作为暂停委托展示，按未成交处理。该记录自身没有成交持仓或现金入账，`continuousExecution:false`。若需恢复或撤销，先查原券商/原账最后有效状态、成交旁证、委托条款和执行归属。Fire 当前无此类迁入委托写入。 |
| `source_registered_history` + `cancelled`、`expired` 或 `rejected` | 封存原状态可读。该行自身未成为买卖成交，实际成交或资金若另有记录需独立核对。当前支持查询。 |
| `internal_pending` | Fire 当前旧委托，未产生该委托行的持仓或现金成交。已核实并移交的在途单应按原 UUID 出现在原生来源。若仍出现在旧来源，先核对状态、移交凭证和关联成交，已有原生账本的本人实盘写入受服务端约束。 |
| `owner_recorded_fill` | 旧 Fire 实际登记成交。目标持仓、原币和当前账本是否承接这笔影响，须核对旧更正链、资金归属和接管基线。已有原生账本的本人实盘旧入口受写入约束，当前原生事务不接收这种旧身份。 |
| `app_order_mirror` | 旧 App 订单镜像证明上传内容。是否另有已入账成交或持仓变动须对账。同本人已有原生账本时，旧镜像修改和删除返回 409。按原 UUID 查有无已接管原生版本。 |

当订单列表无法证明原状态、成交或资金归属，App 应显示相应的未知项。旧委托的 `imported_suspended` 有明确的 Fire 状态，可以显示「迁入暂停」，并单独标明现时券商执行状态缺少依据。

## 混合来源批量删除候选合同

发布时只向 `native_ledger.operations` 追加 `batch_delete`。计划支持同一个已接管本人账户的一组原生订单和可核对的封存成交。已发布的 `trade`、`registered_void` 继续处理各自来源。旧 Fire 缺少 `batch_delete` 时，App 可显示混合选择及待核对原因，混合确认作为整体停止。逐来源各自执行须由用户另行选择和确认。

1. App 将完整有序的选择发送至只读取证 `POST /transactions/preview`。正文为 `{kind:"batch_delete",baseRevision,targets}`，每项 `{source,orderId}`，`source` 为 `native` 或 `registered`。最多 100 项，原单 ID 保持不透明。读取使用 `portfolio.read`，禁用缓存，按本人和显式来源逐项解析。若身份重叠、归属有歧义或发生重复，整组选单冲突。
2. 服务端返回 `data:{ownerId,kind,sourceRevision,evidenceDigest,canCommit,targets,positions,cash}`。各目标返回 `{source,orderId,orderVersion,status,action,proofState,reason,positionEffect,cashEffect,currentOrder}`。动作先支持 `delete_native`、`void_registered`。证据状态为 `verified`、`blocked` 或 `unknown`，原因用稳定代码，例如 `source_ambiguous`、`unsupported_source`、`linked_orders`、`settlement_unverified`、`overlapping_replay`。账务属性为 `recorded`、`none` 或 `unknown`。其中 `currentOrder` 为原生订单的完整当前项或封存成交的精确来源行，无法载入时返回 `null`。`positions` 含原生持仓身份、`quantityBefore,quantityDelta,unitCostBefore`。`cash` 含 `currency,brokerAccountId,balanceBefore,delta`，未知余额为 `null`。证据摘要绑定本人账本版本、整组选单范围、订单版本和所有重放所用数据。遇到任一阻塞条目时返回 `canCommit:false`，保留逐单原因，App 可调整选单后重新取证。
3. App 计算整组订单删除状态、持仓和原币现金，用户确认后向 `POST /transactions` 提交 `{requestId,kind:"batch_delete",baseRevision,evidenceDigest,targets,nativeOrders,positions,cash}`。`targets` 沿用取证中的来源和 ID。`nativeOrders` 中每项为 App 按现有 `trade` 规则生成的删除后形态。封存成交由精确目标和摘要核对，并写审计核销标记。纯状态删除的持仓现金为空，有成交则按持仓 ID 及现金归属和币种各汇总一次。
4. Fire 获取本人写锁，重查版本和整组证据，核对最终余额、成本、持仓可卖数量以及关联成交约束。同一持仓同时涉及两种来源且复算顺序存在冲突时，预览阻塞整组。不同持仓可共享同一原币汇总余额，先合并差额，再验证一次。核销、订单态、持仓、现金、事件和回执在同一 PostgreSQL 事务提交。任一失败整批回滚，返回 `409` 和机器可读理由。封存原件保持可审计。
5. 成功回执为 `{ownerId,requestId,kind:"batch_delete",sourceRevision}`，账本版本只递增一次。丢失响应使用同一 UUID 查回执和原正文重试。回读订单、持仓、原币现金和财务订单。确认精确选中的成交各消失一次，未选中的同证券成交照常显示。

验收覆盖原生未成交单与封存成交同批、两来源共用原币、同持仓复算冲突、未选中的同证券成交保留、未知原币归属、旧服务缺少能力、跨账户隔离、并发变更导致整批失败和同 UUID 重试。

## 旧订单正式接管候选合同

App 使用统一的原生订单身份、计算、审计和操作。本机模式由 App 存储同一套订单，账号同步模式由 Fire 接收同一类订单变更。自行历史补录带实际成交时间并按已成交录入。迁入的旧委托以原始状态和执行证据为准。

现有 `adopt` 接管账户基线及可完整表达的旧在途委托。下一阶段用统一操作 `adopt_orders` 分批接管旧历史订单，适用于已有头版本的账户。开放后只在 `native_ledger.operations` 追加该操作。原生化完成的订单使用共同的原生读写和回执，保留可审计的旧来源。混合来源批量删除只用于过渡期。

### 如何接管

- 只读取证走 `POST /transactions/preview`，提交 `{kind:"adopt_orders",action,baseRevision,targets}`。`action` 为 `adopt` 或 `revert`，每项目标为 `{source,sourceScope,orderId}`，`sourceScope` 表示本人下不透明的来源范围。预览返回 `{ownerId,kind,sourceRevision,evidenceDigest,canCommit,targets}`。各项列出拟生效原生订单 ID、原单号、当前状态、生效状态、来源指纹与原版本、已经核实的持仓和现金影响、未核实原因和依赖项。取消接管时预览同时绑定原接管回执和当前版本。
- 写入走 `POST /transactions`，提交 `{requestId,kind:"adopt_orders",action,baseRevision,evidenceDigest,targets}`，沿用同一回执。Fire 在本人写锁下确认原件、映射、头版本和依赖，原子保存有效订单、来源别名、审计和回执。已有 UUID 且映射唯一时保留。其余订单由服务端为本人、源类型、源实例、源账号及原单 ID 建立持久唯一映射，封存指纹用来核对证据。同 UUID 同正文重试返回原回执。再次选择已接管的来源时在预览返回已有映射，跳过重复接管。来源冲突或别名碰撞暂停该批。
- 已进入期初的成交建立原生有效记录并标明 `opening_included`。它以原成交日参与展示和历史分析，接管事务不会再加减持仓或资金。确认没有成交的委托使用无账务影响；无法确认的持仓、券商余额或历史成本继续显示未知并限制对应的财务操作。迁入暂停委托须在确认原券商没有活跃同单或关联成交后才允许恢复。后续编辑或删除根据已证明的入账状态计算实际差额。
- 订单显示、财务订单、资金来源、持仓重放和更正使用同一个生效身份。接管同一订单前后各显示一次。原生当前余额须按「期初 + 接管后实际账务影响」计算，财务历史则按真实成交日投影。上线前需要统一这些读取路径按入账来源识别已计入期初的成交。

### 可逆性和分批

- 仅接管了身份、未发生更正、合并、状态推进、子单引用或其他账务依赖时，可在最新版本预览后按整批逆转。逆转写审计记录、恢复原来源投影并保留稳定 ID 映射。新旧投影切换前后都须核对持仓和现金一致。已有下游操作时通过新的业务更正处理。
- 预览记录原件摘要、目标顺序和批次大小。大量历史采用持久任务和有界批次，每批保存选择摘要、已验证进度和本批 UUID 回执。关闭页面后接回原任务。版本冲突只暂停未提交部分，重新预览受影响的剩余批次；重试以原 UUID 查回执再提交。已完成的批次保留原进度。
- 先隔离验证原数据直读、接管后对账和回退，再按来源逐步扩大范围。测试覆盖错单和正常单同证券、实际成交日与原号保持、已入期初影响零重复、状态未知、原始 UUID 和旧 App 读取兼容、多个设备并发、账务依赖后拒绝逆转及代表性规模的中断续接。
