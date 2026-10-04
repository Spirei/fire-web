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
