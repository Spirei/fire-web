# App API v2 · 迁移合约 · 2026-10-01

状态：用户已确定迁移，以下合约冻结供 iOS 接入；服务端已实现并完成本地回归，代码通过 main 同步，镜像发布与部署另行进行。v1保留，Web现有API不迁移。v2与v1共享users、grant、业务服务与数据，禁止复制用户库或使用不同持仓源。

## 版本选择（必须先于授权和业务请求）

1. 固定只读引导 GET /api/v1/auth/config，无Cookie/Bearer、禁跳转。新增 api_versions_supported:[1,2]、app_api_version:2、app_api_base_path:"/api/v2"；原version:1与全部v1路径保持不变。
2. 成功且合法的v1发现明确声明支持2时，读取同源固定 GET /api/v2/auth/config 并验证 version:2、固定client_id/redirect_uri/S256以及下述路径；成功后新连接选择2。不接受发现返回的任意主机或地址，不把凭证发给发现指定的第三方。
3. 新 App 连接固定选择2，旧服务器成功返回合法v1配置但没有v2声明时，提示升级服务器，不为新连接选择1。网络失败、5xx、错误结构、声明支持2却v2失败均不能自动降级；用户可稍后重试。
4. apiVersion:1|2必须持久化到具体origin/grant。旧凭据缺apiVersion默认1；只有重新连接/显式迁移才换版本，不在既有请求途中改。token交换、refresh、revoke、身份、资料、业务和安全都使用同一选定版本；独立公共恢复/本地模式的公开行情也先选固定origin的版本并将其绑定到完整操作流程。
5. 请求上下文、缓存和异步结果至少核对origin/grant/apiVersion；后台、取消、超时不重放写请求。v2失败不跨版本重试；API自身40101/40102的刷新策略也不得改变选定版本。旧client_id、回调、token格式、TTL/轮换、scope、grant ID不改，旧grant可凭原权限使用v2，不自动增加权限。

## 发现

v2 GET auth/config 返回统一{code,message,data}，data.version=2，api_versions_supported:[1,2]、app_api_version:2、app_api_base_path:"/api/v2"，其余协议字段与v1一致，但token_path、revoke_path、profile_path、upload_path、email_path、password_path、feed_path均使用/api/v2前缀。

authorization_path仍是/app/authorize，authorization_submit_path明确/api/v1/auth/authorize。PKCE同意是网页交互，因此继续在Web会话中执行，不新增v2 Cookie授权接口；App以选定版本的auth/token交换同一个一次性code。devices_path仍为/app/devices（网页管理地址），原生设备接口见security.devices_path。

security.version=2，read_scope:security.read/write_scope:security.write；security中的email_verification_path、totp_path、passkeys_path、devices_path、password_reset_path全部为对应/api/v2/auth路径。其余能力粒度、错误码和请求响应沿用 native-account-security-v1.md；只改变前缀及version。auth/me继续直接User，邮箱confirm.user.emailVerified为true；qrPng是data:image/png;base64；expiresAt是Unix毫秒；backup-codes.reauthenticationRequired必须按响应boolean处理。原生Passkey注册继续false/503。

## 认证边界与响应

私有端点仅接受Authorization: Bearer fat_... App access token，不接受Cookie、Web session Bearer或由客户端选择userId；App永远按普通用户自身权限处理。无效会话40101/40102，scope不足40301且不清会话，密码/因子错误40103/40104且HTTP403。公开行情/图标/目录可匿名读取，忽略Cookie的身份，不授予个人数据或管理员能力；若显式携带Bearer则必须为有效App grant。App专用指受独立合约管理，公开资源不通过User-Agent假装限制调用者身份。

所有已公布JSON端点使用{code,message,data,meta?}，保持原有业务字段、分页及业务语义；fire-settings 的 v1 历史裸JSON仅在v2包装为统一信封，GET data={fire}，PUT data={ok,assetHistory}，请求体仍为{fire,assetRecord?}。错误不泄露内部诊断。不迁移裸JSON、备份/导入导出、管理员素材/券商写入、旧密码login的Web会话合同、Cookie auth/devices、delete-account和portfolio-series。v2原生登录是独立短期App令牌合同，见下文。非支持方法返回405，未公布路径404，无跨版本重定向。

## 完整路径与方法（相对于 /api/v2）

| 路径 | 方法 | 权限 |
|---|---|---|
| `auth/config` | GET | public |
| `auth/login` | POST | credential |
| `auth/login/totp` | POST | credential |
| `auth/permissions` | POST | 有效本人 App grant；明确申请 scope，不重复验证密码/二步 |
| `market-calendar` | GET | public（仅 v2） |
| `market-calendar/batch` | GET | public（仅 v2） |
| `auth/token` | POST | credential |
| `auth/revoke` | POST | credential |
| `auth/password-reset/request` | POST | credential |
| `auth/password-reset/verify` | POST | credential |
| `auth/password-reset/confirm` | POST | credential |
| `auth/me` | GET | portfolio.read |
| `auth/profile` | PUT | profile.write |
| `auth/email` | PUT | portfolio.read |
| `auth/password` | POST | portfolio.read |
| `auth/email-verification` | GET | security.read |
| `auth/email-verification/request` | POST | security.write |
| `auth/email-verification/confirm` | POST | security.write |
| `auth/totp` | GET | security.read |
| `auth/totp/setup` | POST | security.write |
| `auth/totp/confirm` | POST | security.write |
| `auth/totp/disable` | POST | security.write |
| `auth/totp/backup-codes` | POST | security.write |
| `auth/passkeys` | GET,DELETE | security.read；写入 security.write |
| `auth/passkeys/register-options` | POST | security.write |
| `auth/passkeys/register-verify` | POST | security.write |
| `auth/security-devices` | GET,DELETE | security.read；写入 security.write |
| `overview` | GET | portfolio.read |
| `records` | GET,POST | portfolio.read；写入 portfolio.write |
| `records/[id]` | PUT,DELETE | portfolio.write |
| `records/group-assign` | POST | portfolio.write |
| `records/group-reorder` | POST | portfolio.write |
| `watch-groups` | GET,POST | portfolio.read；写入 portfolio.write |
| `watch-groups/[id]` | PUT,DELETE | portfolio.write |
| `watch-groups/[id]/icon` | POST | portfolio.write |
| `watch-groups/reorder` | POST | portfolio.write |
| `orders` | GET,POST | portfolio.read；写入 portfolio.write |
| `orders/[id]` | PUT,DELETE | portfolio.write |
| `funds` | GET,POST | portfolio.read；写入 portfolio.write |
| `funds/[id]` | DELETE | portfolio.write |
| `fire-settings` | GET,PUT | portfolio.read；写入 portfolio.write |
| `simple-ledger` | GET,PUT | portfolio.read；写入 portfolio.write |
| `upload` | POST | profile.write |
| `brokers` | GET | portfolio.read |
| `assets` | GET | public |
| `assets/lookup` | GET | public |
| `celebs` | GET | public |
| `celebs/[id]` | GET | public |
| `celebs/[id]/returns` | GET | public |
| `quotes` | POST | public |
| `quote-subscriptions` | GET,POST,DELETE | portfolio.read；写入 portfolio.write |
| `charts` | POST | public |
| `chart-series` | GET | public |
| `kline` | GET | public |
| `index-kline` | GET | public |
| `kline-sessions` | GET | public |
| `stock-detail` | GET | public |
| `search` | GET | public |
| `earnings` | GET | public |
| `rates` | GET | public |
| `indices` | GET | public |
| `company-profile` | GET | public |
| `settings/public` | GET | public |
| `feed` | GET | feed.read |
| `feed/groups` | GET/POST | feed.read / feed.write |
| `feed/groups/[groupId]` | PUT | feed.write |
| `feed/subscriptions/test` | POST | feed.write |
| `feed/preferences` | PUT | feed.write |
| `feed/refresh` | POST | feed.write |
| `feed/profile` | GET/PUT | feed.read / feed.write |
| `feed/profile/avatar` | POST | feed.write |
| `feed/jobs` | GET | feed.read |
| `feed/jobs/[jobId]` | GET | feed.read |
| `feed/posts/[postId]` | GET,PUT | feed.read；写入 feed.write |
| `feed/posts/[postId]/discussion` | GET,POST | feed.read；写入 feed.write |

security接口的完整payload见 native-account-security-v1.md，将其中/api/v1替换为/api/v2；其余业务请求/响应沿用docs/api-spec.md对应v1资源，不变更金额、订单和分页含义。credentials类端点以请求体里的PKCE/refresh/revoke/recovery或原生登录凭证验证，不依赖Cookie。

动态新闻分组、订阅、文章、讨论及Agent的冻结接入见 [app-feed-news.md](app-feed-news.md)。发现的可选feed_contract修订1返回本版groups_path与subscriptions_test_path；缺声明的旧部署不能视为分组管理已支持。现有App保持所选API版本、原凭据与明确扩权边界，people模式本轮不纳入App。

## App 内账号密码登录

两版 auth/config 的 native_login 声明固定 v2 登录、二步与扩权路径。基础登录仅授予 portfolio.read portfolio.write，返回15分钟 access、轮换 refresh、grant、apiVersion 与同 auth/me 的完整 User；不建立 Web 会话。TOTP/备用码使用5分钟、最多8次、单次成功消费的独立摘要挑战。额外 profile/feed/security 权限由用户通过有效本人连接明确申请，不重复验证密码或二步，成功签发新 grant，客户端原子保存后再撤销旧 grant；失败保留旧连接。

完整发现、请求、响应和错误码见 [native-app-login-v2.md](native-app-login-v2.md)。未声明 native_login 的服务器不可猜端点或降级为 v1 长期 Web token。测试只使用临时数据库，不表示线上已部署；新登录凭证和既有 PKCE 凭证使用同一刷新、撤销和设备管理服务。

## 服务端交付验证

- npx tsc --noEmit、生产构建、npm run test:review、公开仓库与部署一致性审计、git diff --check 通过。
- tests/app-v2.cjs 共10组，覆盖 v1/v2 发现、全部私有方法拒绝 Cookie/Web Bearer、旧 scope 不扩权、共享投资数据与本人权限、匿名行情、跨版本一次性 PKCE/refresh、TOTP 原子回滚、异步撤销、动态路径与方法边界。仅使用临时 SQLite 与模拟网络；原生安全12组和既有 v1 回归同样通过。
- 本机固定3000端口由另一实例占用，未停止该实例或更换端口，未运行此分支 HTTP 冒烟；也未做已部署服务与实体 iOS 的端到端验收。
- 代码推送与镜像发布为独立步骤；本轮仅同步 main，不触发手动镜像发布。客户端必须依据实际发现结果选择版本，不得根据代码推送假设线上已经有 v2。

## 文档页（2026-10-01）

API 文档入口仍为 /api-docs，?version=v1 或 ?version=v2 切换，省略为v1。v2公开参考为 docs/api-spec-v2.md，包含发现、PKCE、scope、原生安全与全量公布方法；后台文档接口 /api/api-docs 使用相同version参数固定选择文件，不接受路径。两版独立编辑、修订校验、原子文件替换与当前管理员身份检查。生产镜像复制两份文档并允许node用户保存。

- 文档测试5组、迁移测试10组、完整test:review、独立类型检查、生产构建、审计通过。
- 使用实际React页面与样式做隔离浏览器预览：版本点击、网址、刷新/返回、草稿与保存目标，桌面/平板/手机深浅色通过。预览使用模拟发现/文档读写及导航，不等于已部署Next服务或正式账号联调；仍未占用或改动另一实例的3000端口。


## 休市日历

新增公开只读 `GET /api/v2/market-calendar?market=US&year=2026`，仅 v2，无新增 scope。两版 auth/config 均以 market_calendar.path 指向固定 v2 地址。完整合约见 [market-calendar-api.md](market-calendar-api.md)，包括当地日期、半日市、未知年份、临时停市未确认与 ETag。不得改变纽约20:00盈亏归档周期或据未知状态写入业务数据。

休市日历「全部」使用 `/api/v2/market-calendar/batch?year=2026`，data.calendars 按 US/HK/CN 分开保存；单市场继续使用原接口，发现对象新增固定 batch_path。两种方式共用年度版本，不重复抓取官方来源。


## App 个人资源库

个人资源库冻结合约 1：`resource_library` discovery、`resources.read/resources.write` 显式授权；默认登录范围不变。两版本共用用户隔离服务，接收文件为构建/影音内容的统一筛选入口。字段、分页/排序、50 MiB 上传、1 GiB 额度、Bearer 私有下载及物理删除回执见 [个人资源库合约](app-resource-library.md)。

## 用户行情订阅与共享池

`auth/config.quote_subscriptions_contract` 返回固定 `/api/v2/quote-subscriptions`。行情批量、总览、完整个股详情的认证读取自动登记本人需求，App 不必先订阅才能读取。也可 GET 查看本人列表、POST `{items:[{market,code}]}` 显式订阅/续期、DELETE 同格式取消部分或 `{all:true}` 清空本人；私有读取需 portfolio.read、写入需 portfolio.write，不扩权。单次最多100只、请求64KiB、本人256只；规范代码去重，返回 market/code、最后请求和到期 Unix 毫秒时间、hot/dormant。详细契约见 [用户行情订阅](api-spec-v2.md)。

本人需求存入 SQLite，七天无人请求自动到期，90秒无人读取暂停主动更新，后台更新和列表查询不续期。首次认证需求在重启后恢复未到期条目。共享行情按市场独立容量和调度，同证券跨用户只读一份公共报价，不共享持仓与资金；取消/到期仅释放本人需求，其他读者仍需时保留。取消不删除持仓，下次行情读取重新登记；历史读取不登记。公共报价仍为进程内缓存，多服务器不统一调度。

<details>
<summary>App 账户交易与独立现金核对（2026-10-13）</summary>

同源 auth/config 新增 account_trading；v1/v2 共用交易预览、提交、改单、明确行情观察及持久回执。新交易须 orders.write，批量撤单须 orders.cancel，旧授权不扩权。本机定投、文档、发帖、标注和偏好保持本机边界。内部记账不向外部券商下单、不承诺后台执行。完整路径与权限见同源发现的固定声明；原生适配器同时核对仓库 docs/app-account-trading.md 合同。

### 预览与提交

先 GET trading，捕获 accountId、snapshotRevision 及对应持仓 recordRevision。版本是服务端金融输入的 SHA-256，行情变化不会改变它；记录、声明、订单状态、现金流水和附加单状态变化会使旧预览失效。只能提供本人已存在、已声明 cash_equity/etf 且未声明退市的证券。未知数量／成本／现金不得补零。数量、价格、费用为有限 JSON number，至多八位小数，单笔金额上限 10^12；这只是内部记账单位，不冒充交易所最小手数。

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

POST cash 为 `{requestId,accountId,snapshotRevision,currency,balance,note?}`；balance 为本人核对的该币种合计现金，含银行与既有现金来源，不能当某个券商独立子账户。核对只追加 adjustment 差额，保留名称和原流水；数值没有变化也保存一次确定回执。当前来源不完整、版本冲突或差额不可核对时拒绝，不从总权益／股价反推余额。市场现金拆分仍不可用。

## 回执、失败与生命周期

所有写请求只发送一次，requestId 为小写 UUID，与证券声明及撤单共用本人操作命名空间；跨版本重复为40901，不能重放。成功信封 data 为 `{requestId,accountId,kind,state,code,message,data,completedAt}`，kind 为 submit_trade/amend_trade/observe_trade/reconcile_cash/cancel_orders。确定业务冲突返回相应错误并保存 state=failed/data=null 回执；存储异常完整回滚，不伪造成功。

请求超时、断网、返回后台或401时，不刷新并重放写入；只用原 requestId 查询 operations。查询404不等于可以自动重发，须重新读取并由本人确认新请求。grant/origin/apiVersion/account/cache 代次变化取消旧请求与草稿消费，迟到结果不覆盖新账户；成功写入或明确失败后重新读取真实账户状态。普通读取可以沿原 token 刷新合并规则，新写入不得自动刷新重发。

备份恢复：普通 JSON 迁移升级为格式 v2，保留港股通 account_market、实际 settlement_currency/settlement_amount，仍接受旧 v1；资金重建与导入同一事务。含 API 交易元数据的账户不使用旧 JSON 导出或覆盖恢复，发现声明 portable_json_transfer 不支持；请使用保留所有表的完整数据库备份。原账户回执与条件单不能在迁移中被删除或降成旧惰性执行单。

验收：tests/app-asset-orders.cjs、tests/app-trading.cjs 使用独立 SQLite、真实 v1/v2 路由和授权，禁止向真实账户写测试成交、现金或条件单。生产镜像更新后，再检查同源 auth/config 和实际 buildSha；App 原生适配器、手机安装与真实外部券商执行不能由服务端回归代替。


</details>
