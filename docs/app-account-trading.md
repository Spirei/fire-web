# App API 账户交易合同 v1

2026-10-13。服务端实现与隔离回归，不代表生产镜像、原生适配器或手机已经更新。v1/v2 使用同一业务服务和数据库；从所选版本同源 `auth/config.account_trading` 发现固定路径。App 必须确认完整声明、实际授权及账户身份才开放新提交。默认和旧 grant、刷新令牌和切换版本均不增加权限。

本轮按用户选择保留本机边界：定投、助手文档、个人发帖、标注、模板和交易偏好继续在 App 本机保存，不上传，不混合本机与 API 的现金、持仓或回执。Agent 是独立服务，不从金融 API 探测或转发其凭据。APNs 保持此前暂停状态。

## 对接清单

| App 能力 | 对接 |
| --- | --- |
| 原有资产与独立现金估值 | `account_assets` 原合同；行情不改变独立现金 |
| 全部／当日订单、六种状态、批量撤单 | 恢复 `account_assets.orders_version=1`；列表不结算／不自动过期；新撤单需 `orders.cancel` |
| API 交易面板 | 新 `account_trading`；预览、提交、改单、明确行情观察、回执恢复 |
| API 可用现金修改 | `cash_path`；显式核对目标余额，写调整差额，不覆盖原流水 |
| 港股通 | `market=HK/accountMarket=CN`，A/H，价格和费用 HKD，现金只记实际 CNY 结算净额；不创建自动委托／附加单 |
| 模板／交易设置 | 本机偏好；在每笔显式提交中携带选定参数，不扩全局站点设置权限 |
| 定投、聊天文档、个人发帖和标注 | 保持本机，不增加金融 API 请求 |

## 路径和权限

下表以 v2 为例，v1 仅替换 `/api/v2` 为 `/api/v1`。所有路径均固定同源，仅接受 App Bearer，拒绝 Cookie。基础 grant 仍须 `portfolio.read`；旧 `portfolio.read/write` 继续代表原合同的广义投资读取／管理，不自动赋予新交易权限。

| 方法 | `/api/v2/account-assets/` 后缀 | 所需范围 |
| --- | --- | --- |
| GET | `summary` | assets.read |
| GET | `positions` | positions.read |
| GET | `cash` | cash.read |
| POST | `cash` | portfolio.write |
| GET | `orders?scope=today或all&status=all` | portfolio.read，兼容已存在的原生列表合同 |
| POST | `orders/cancellations` | orders.cancel |
| GET | `trading` | orders.read |
| POST | `trading/preview` | orders.write |
| POST | `trading/submissions` | orders.write |
| POST | `trading/orders/{orderId}/preview` | orders.write |
| PUT | `trading/orders/{orderId}` | orders.write |
| POST | `trading/orders/{orderId}/observations` | orders.write |
| GET | `operations/{requestId}` | portfolio.read |

`assets.read/positions.read/cash.read/orders.read/orders.write/orders.cancel` 在发现中实际声明，可按原生 permissions 或 PKCE 流程申请。旧连接不自动扩张。授权同意页和设备列表明确标识交易提交／撤单；auth/me.capabilities 的同名布尔键反映实际 grant。不要把旧 portfolio.write 当作新 orders.write 或 orders.cancel。

## 预览与提交

先 GET trading，捕获 accountId、snapshotRevision 及对应持仓 recordRevision。版本是服务端金融输入的 SHA-256，行情变化不会改变它；记录、声明、订单状态、现金流水和附加单状态变化会使旧预览失效。只能提供本人已存在、已声明 cash_equity/etf 且未声明退市的证券。未知数量／成本／现金不得补零。数量、价格、费用、附加单比例及限价／费用、港股通实际净结算额为有限 JSON number，至多八位小数，单笔金额上限 10^12；这只是内部记账单位，不冒充交易所最小手数。

示例（占位 ID／版本由实际读取替换）：

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "accountId": "本人账户ID",
  "recordId": "本人证券ID",
  "recordRevision": 1,
  "snapshotRevision": "实际读取的64位十六进制版本",
  "side": "buy",
  "mode": "record",
  "orderType": "limit",
  "qty": 2,
  "price": 10,
  "fees": 0,
  "tif": "gtc",
  "session": "REGULAR",
  "tradedAt": "2026-10-13T01:30:00.000Z",
  "note": ""
}
```

side 为 buy/sell/dividend；dividend 仅 actual record，不能附加单。mode=record 必须提供已发生、带时区且不早于该证券已记录成交的实际时间；日期不得归一化为其他日。缺历史基线时不重写过去成交，先核对历史顺序；mode=order 禁止 tradedAt。orderType 为 limit/market，tif 为 day/gtc；session 为 REGULAR/EXTENDED，仅 US 支持扩展时段。费用必须本人明确登记，包括明确填写 0；feeSource=owner_recorded、feeBreakdown=null，不假造佣金或购买力。港股通 record 另提供正 settlementAmount，即券商实际 CNY 实付／实收净额（含费用），不是当前 FX 换算。

preview 不写业务数据，返回金额、费用、原币、净结算额、现金／数量／摊薄成本前后值和其他待执行单占用。费用、数量和价格或账户输入变化后必须重新预览。pending 占用在每次实际成交前再核对，同一 OCO 组只占一次；没有融资、卖空或部分成交。API 金额与 Web 共用既有摊薄成本和现金记账，不套用本机不同的成本策略。

改单确认使用发现的 `amend_preview_path`：POST `trading/orders/{orderId}/preview`，请求与 PUT 相同并提供 orderRevision。服务端只读核对本人最新 pending API 主单及原证券／渠道身份，排除被修改订单本身的占用，继续保留其他委托占用，返回 orderId/orderRevision。修改提交复用同一校验；新建 preview 不接受 orderRevision，不能冒充改单预览。 API 主单项提供 attachmentInputsAvailable 及 attachments（原确认输入，null 表示明确未设置）；子单和旧订单不提供完整配置证明。改单编辑必须先还原全部比例、逐腿类型／委托价／费用、时段及有效期，不能从尚未生成的子单反推或默默清空原配置。

submissions 在同一事务核对 grant、账户、快照、证券版本、现金和数量，再写订单、持仓、资金流水、附加单元数据和回执。record 原子登记真实成交，订单项 executionModel=owner_recorded_fill；order 创建 pending，executionModel=explicit_quote_observation，不在提交时猜测市价成交。清仓保留明确数量 0，允许核对后再次买入；缺失数量仍拒绝，不推断为 0。回执只保留本次变动及必要核对状态，不重复存整份账户历史。PUT 改单提供同一交易输入及最新 orderRevision；仅支持尚未成交的 API 主单，保留 ID／订单号／原创建时间。确认时间单独记录，旧报价不能用于改后委托。已成交历史不经旧订单接口删除或重写；同一证券存在 API 成交后，旧接口也不能通过更正早期订单重放并改写这些回执，Web 隐藏对应入口。

## 明确行情观察与附加单

新 API 条件单与旧惰性结算隔离；读取账户、列表或旧订单页均不能使它成交。仅 App 当前允许执行时 POST observations，body 为 requestId/accountId/snapshotRevision/orderRevision/recordRevision；服务端独立取得同证券真实行情，不接受客户端价格。来源仅 futu/tencent/yahoo；必须有可解析交易所时间（含腾讯斜杠／紧凑日期）、保存或改单后报价、最多30秒且非未来、有效价格和明确 REGULAR/PRE/AFTER 时段。未知、夜盘、过期、失效账户或缺输入不能成交。没有后台自动执行承诺，未观察到的期间不回溯成交。当日有效到期由明确观察请求确认。

attachments 可选，结构为 `{takeProfit?,stopLoss?,session,tif}`，至少一项；每项 `{percent,orderType,limitPrice?,fees}`，percent 在0与100之间，market 不接受 limitPrice，limit 缺委托价时采用实际触发价。每笔子单的费用必须明确提供。主单全额成交后才按真实成交价建立相反方向、同成交数量的子单；止盈／止损共享 parentOrderId。限价子单触发后保留已触发状态，不能因价格再次跨越触发点而丢失激活。任一子单全额成交，同次事务撤销待执行的另一侧。订单返回 attachmentRole、parentOrderId、revision 和真实状态；不假称外部券商已经收到或执行。

## 现金核对与流水

GET cash 返回本人 accountId/snapshotRevision、独立原币现金来源与完整性、已存资金流水及 pagination。查询只接受 limit（1–200，默认100）、offset（非负整数）、currency、snapshotRevision；后续分页沿相同快照，变化为40902，重新读取第一页。transactionSource=stored_fund_ledger，ordersCashSource=filled_trade_orders；旧成交尚无存储的自动流水时，读取不补写，独立余额仍按真实成交核算。

POST cash 为 `{requestId,accountId,snapshotRevision,currency,balance,note?}`；balance 为本人核对的该币种合计现金，含银行与既有现金来源，不能当某个券商独立子账户。balance 为有限 JSON number，绝对值不超过 10^12，至多八位小数，允许明确的零及负余额；超出精度直接拒绝。核对只追加 adjustment 差额，保留名称和原流水；数值没有变化也保存一次确定回执。当前来源不完整、版本冲突或差额不可核对时拒绝，不从总权益／股价反推余额。市场现金拆分仍不可用。

## 回执、失败与生命周期

所有写请求只发送一次，requestId 为小写 UUID，与证券声明及撤单共用本人操作命名空间；跨版本重复为40901，不能重放。行情观察在访问行情源之前按本人账户检查已有回执，避免重复请求消耗行情；真正记账的事务内再次检查，覆盖等待行情期间另一请求完成的并发情形。成功信封 data 为 `{requestId,accountId,kind,state,code,message,data,completedAt}`，kind 为 submit_trade/amend_trade/observe_trade/reconcile_cash/cancel_orders。确定业务冲突返回相应错误并保存 state=failed/data=null 回执；存储异常完整回滚，不伪造成功。

请求超时、断网、返回后台或401时，不刷新并重放写入；只用原 requestId 查询 operations。查询404不等于可以自动重发，须重新读取并由本人确认新请求。grant/origin/apiVersion/account/cache 代次变化取消旧请求与草稿消费，迟到结果不覆盖新账户；成功写入或明确失败后重新读取真实账户状态。普通读取可以沿原 token 刷新合并规则，新写入不得自动刷新重发。

备份恢复：普通 JSON 迁移升级为格式 v2，保留港股通 account_market、实际 settlement_currency/settlement_amount，仍接受旧 v1；资金重建与导入同一事务。含 API 交易元数据的账户不使用旧 JSON 导出或覆盖恢复，发现声明 portable_json_transfer 不支持；请使用保留所有表的完整数据库备份。原账户回执与条件单不能在迁移中被删除或降成旧惰性执行单。

验收：tests/app-asset-orders.cjs、tests/app-trading.cjs 使用独立 SQLite、真实 v1/v2 路由和授权，禁止向真实账户写测试成交、现金或条件单。生产镜像更新后，再检查同源 auth/config 和实际 buildSha；App 原生适配器、手机安装与真实外部券商执行不能由服务端回归代替。
