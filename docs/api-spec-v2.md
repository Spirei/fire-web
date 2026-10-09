# Alcor · API 规范（v2）

## App 资产快照与证券资料声明

匿名 auth/config 的 account_assets 声明能力；精确字段、类型和缺失语义见 [冻结合约](native-account-assets-contract.md)。新接口只接受 App Bearer，后台读取不结算挂单。

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v2/account-assets` | portfolio.read |
| GET | `/api/v2/account-assets/instruments/{recordId}` | portfolio.read |
| PUT | `/api/v2/account-assets/instruments/{recordId}` | portfolio.write |
| GET | `/api/v2/account-assets/operations/{requestId}` | portfolio.read |

App 专用接口，固定前缀 `/api/v2`。与 Web / v1 共用账号、授权、持仓及账本，版本切换不搬迁数据。私有接口只接受 App access token；公开行情和图标支持本地模式匿名读取。

## 1. 版本发现与迁移

<details>
<summary>新连接 · 先发现，再授权</summary>

1. 无 Cookie / Bearer 读取固定同源 `GET /api/v1/auth/config`，禁止跳转。
2. 合法 v1 配置包含 `api_versions_supported:[1,2]`、`app_api_version:2`、`app_api_base_path:"/api/v2"` 时，再读取固定同源 `GET /api/v2/auth/config`。
3. 验证 `version:2`、固定 client / callback、S256 和全部接口路径。成功后新连接选择 v2；新 App 连接固定使用 v2；旧服务器未声明支持2时提示升级服务器。
4. 超时、5xx、结构错误或声明2却 v2 不可用，均不能静默降级。

按 origin / grant 持久化 apiVersion。旧凭据缺少版本时为 v1；重新连接或明确迁移时才切换。授权兑换、刷新、撤销及完整业务请求固定同一版本；缓存和异步结果也区分版本。写请求超时或进入后台后不自动重放，不跨版本重试。

</details>

<details>
<summary>v2 发现 · 固定路径与能力</summary>

```json
{
  "version": 2,
  "api_versions_supported": [1, 2],
  "app_api_version": 2,
  "app_api_base_path": "/api/v2",
  "client_id": "fire-ios",
  "redirect_uri": "com.fire.app:/oauth/callback",
  "authorization_path": "/app/authorize",
  "authorization_submit_path": "/api/v1/auth/authorize",
  "token_path": "/api/v2/auth/token",
  "revoke_path": "/api/v2/auth/revoke"
}
```

这是 `auth/config` 的 data 摘要。完整响应还包含 scope、scopes_supported、code_challenge_methods_supported、profile_path、upload_path、email_path、password_path、feed_path、security 和 native_login。

security.version 为2，read_scope / write_scope 为 security.read / security.write，email_verification_path、totp_path、passkeys_path、devices_path、password_reset_path 都使用 `/api/v2/auth`。

网页 PKCE 同意仍在 `/app/authorize`，网页提交固定 `/api/v1/auth/authorize`。这两个地址使用浏览器会话；App token 兑换使用选定版本。发现字段不是任意主机的授权，凭据不发送到第三方地址。

</details>

## 2. 原生登录、PKCE 与授权范围

<details>
<summary>App 内登录 · 账号密码与二步验证</summary>

两版 `auth/config` 的 `native_login` 明确声明 `supported:true`、`version:1`、`api_version:2`、固定 `client_id:"fire-ios"`、`login_path:"/api/v2/auth/login"`、`two_factor_path:"/api/v2/auth/login/totp"`、`permissions_path:"/api/v2/auth/permissions"`、基础 scope、scopes_supported、factors:["totp","backup_code"] 和 challenge_expires_in:300。缺少能力声明不猜端点，不降级到旧 Web 长期令牌。

匿名 POST `/api/v2/auth/login`：`{client_id:"fire-ios",username,password,device_name?}`。支持用户名或邮箱，拒绝额外 `scope/userId`。基础范围固定 `portfolio.read portfolio.write`，不设置 Cookie、不建立 Web session。

无二步验证，成功 data 为 `{status:"authenticated",apiVersion:2,access_token,refresh_token,token_type:"Bearer",expires_in:900,grant_id,scope,user}`。User 与该 access 调用 auth/me 完全相同，包含真实头像、完整 capabilities 与 security；App role 固定 user。

启用二步时仅返回 `{status:"requires_2fa",apiVersion:2,purpose:"login",challenge_token:"flc_...",expires_in:300,factors:["totp","backup_code"]}`，不返回 User 或会话令牌。匿名 POST `/api/v2/auth/login/totp`：`{client_id:"fire-ios",challenge_token,code}`，成功返回同一 authenticated 结构。挑战保存摘要、绑定账户安全状态/client/origin/scope/用途，5分钟过期、最多8次、成功单次消费；不能与 Web ticket 混用。

密码错误40103、因子错误40104、挑战无效/过期/已使用40105均为 HTTP403，保留旧连接；限流42901。凭证消费与 grant 创建同事务，失败不部分写入或消费备用码。新 grant 使用相同的15分钟 access、轮换 refresh、30天空闲/90天最长与重放撤销策略。

</details>

<details>
<summary>额外权限 · 用户明确申请</summary>

POST `/api/v2/auth/permissions`，携带当前 App Bearer：`{client_id:"fire-ios",scope:"profile.write"}`。scope 为明确申请的范围，最终并入原 scope，security.write/feed.write 需各自 read；普通登录、启动及恢复连接不能自动扩权。

有效本人连接明确申请后直接返回 authenticated，不要求密码或二次验证码，也不创建 permissions 挑战。native_login.version=2，permissions_authentication="current_grant"，permissions_requires_password=false，permissions_requires_2fa=false；旧客户端的 currentPassword 字段仍接受但不使用。只有实际修改邮箱、密码、两步验证、删除密钥/设备/账号等敏感操作才校验凭据，登录验证保持不变。

成功产生新 grant，返回 replaces_grant_id；旧 grant 权限不变。客户端原子保存新 access、refresh 与 origin/grant/apiVersion 后再撤销旧 grant。失败、取消、过期或限流不清旧连接；只有当前 Bearer 确实无效时返回 HTTP401/40101或40102。

</details>

<details>
<summary>系统浏览器授权 · 一次性代码兑换</summary>

App 本地生成随机 verifier、state 与 S256 challenge；打开授权页面时提交 response_type=code、client_id=fire-ios、redirect_uri=com.fire.app:/oauth/callback、code_challenge_method=S256、code_challenge、state 和 scope。

收到回调后精确核对 callback URI 和 state，仅向同源端点提交：

```http
POST /api/v2/auth/token
Content-Type: application/json
```

```json
{
  "grant_type": "authorization_code",
  "client_id": "fire-ios",
  "redirect_uri": "com.fire.app:/oauth/callback",
  "code": "fac_<一次性代码>",
  "code_verifier": "<原始随机 verifier>"
}
```

成功 data 包含 access_token、refresh_token、token_type、expires_in、scope 和 grant_id。代码只能兑换一次，v1/v2 共用这一限制。将凭据与 origin / grant / apiVersion 一起原子保存在安全存储中，不放 URL、日志或公共缓存。

```http
Authorization: Bearer fat_<App access token>
```

</details>

<details>
<summary>Scope · 读写分开，旧授权不扩权</summary>

| 范围 | 能力 |
| --- | --- |
| portfolio.read | 本人身份、投资读取、券商读取，凭当前密码修改本人邮箱或密码 |
| portfolio.write | 本人投资、分组、订单、资金与账本写入 |
| profile.write | 本人资料和头像编辑 |
| feed.read / feed.write | 本人动态读取 / 编辑、生成和讨论 |
| security.read / security.write | 本人账户安全读取 / 管理 |

所有授权必须有 portfolio.read；默认 portfolio.read portfolio.write 保持不变。feed.write 必须同时有 feed.read，security.write 必须同时有 security.read。可选范围必须由用户明确请求，经有效本人连接显式申请或网页 PKCE 同意；刷新令牌或切换版本不增加权限。App 授权不继承网站管理员权限。

</details>

<details>
<summary>刷新与断开 · 不跨版本重试</summary>

POST `/api/v2/auth/token`：`{grant_type:"refresh_token",client_id:"fire-ios",refresh_token}`。access token 有效15分钟；refresh token 轮换，闲置30天、总期限90天。重放旧 refresh 会撤销同一家族，v1/v2 共用撤销状态。

POST `/api/v2/auth/revoke`：`{client_id:"fire-ios",token}`，token 可为 fat_ access 或 frt_ refresh；撤销所属 grant。

刷新保持原 grant 和范围；发生40101/40102可按既有会话策略处理，不能切换API版本。40301权限不足及40103/40104凭据校验失败不等于连接过期。

</details>

## 3. 响应与错误

```json
{"code":0,"message":"ok","data":{}}
```

分页接口另含 meta。成功读 data，失败结合 HTTP 状态与 code；不要只按 HTTP401或业务码前缀清除连接。

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | 40001 / 40002 / 40003 | 参数、请求体或恢复验证码无效 |
| 401 | 40101 / 40102 | 缺少有效 App token / 连接过期或已撤销 |
| 403 | 40301 | scope不足或来源不可信 |
| 403 | 40103 / 40104 / 40105 | 密码错误 / 第二因素错误 / 原生登录挑战无效，旧连接保持 |
| 404 | 40401 | 本人资源不存在 |
| 409 | 40901 / 40902 | 数据冲突或安全挑战过期 |
| 429 | 42901 | 请求限流 |
| 500 | 50001 | 内部错误 |
| 503 | 50301 | 原生通行密钥注册未启用 |

已公布方法以外返回405，未公布路径404，不重定向到另一版本。安全响应和令牌不缓存。失败不泄露内部诊断。

## 4. 完整接口清单

public 可匿名访问且不继承 Cookie 身份；显式携带 Authorization 时需有效 App grant。credential 根据请求体内的 PKCE、refresh、revoke、恢复或原生登录凭证认证。其他行写出所需 scope，均只操作当前 grant 用户。

### 4.1 连接与身份

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v2/auth/config` | public |
| POST | `/api/v2/auth/login` | credential |
| POST | `/api/v2/auth/login/totp` | credential |
| POST | `/api/v2/auth/permissions` | portfolio.read |
| GET | `/api/v2/market-calendar` | public |
| GET | `/api/v2/market-calendar/batch` | public |
| POST | `/api/v2/auth/token` | credential |
| POST | `/api/v2/auth/revoke` | credential |
| GET | `/api/v2/auth/me` | portfolio.read |
| PUT | `/api/v2/auth/profile` | profile.write |
| PUT | `/api/v2/auth/email` | portfolio.read |
| POST | `/api/v2/auth/password` | portfolio.read |

### 4.2 原生账户安全

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/v2/auth/password-reset/request` | credential |
| POST | `/api/v2/auth/password-reset/verify` | credential |
| POST | `/api/v2/auth/password-reset/confirm` | credential |
| GET | `/api/v2/auth/email-verification` | security.read |
| POST | `/api/v2/auth/email-verification/request` | security.write |
| POST | `/api/v2/auth/email-verification/confirm` | security.write |
| GET | `/api/v2/auth/totp` | security.read |
| POST | `/api/v2/auth/totp/setup` | security.write |
| POST | `/api/v2/auth/totp/confirm` | security.write |
| POST | `/api/v2/auth/totp/disable` | security.write |
| POST | `/api/v2/auth/totp/backup-codes` | security.write |
| GET | `/api/v2/auth/passkeys` | security.read |
| DELETE | `/api/v2/auth/passkeys` | security.write |
| POST | `/api/v2/auth/passkeys/register-options` | security.write |
| POST | `/api/v2/auth/passkeys/register-verify` | security.write |
| GET | `/api/v2/auth/security-devices` | security.read |
| DELETE | `/api/v2/auth/security-devices` | security.write |

### 4.3 投资与账本

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v2/overview` | portfolio.read |
| GET | `/api/v2/records` | portfolio.read |
| POST | `/api/v2/records` | portfolio.write |
| GET | `/api/v2/records/{id}` | portfolio.read |
| GET | `/api/v2/records/operations/{requestId}` | portfolio.read |
| PUT | `/api/v2/records/{id}` | portfolio.write |
| DELETE | `/api/v2/records/{id}` | portfolio.write |
| POST | `/api/v2/records/group-assign` | portfolio.write |
| POST | `/api/v2/records/group-reorder` | portfolio.write |
| GET | `/api/v2/watch-groups` | portfolio.read |
| POST | `/api/v2/watch-groups` | portfolio.write |
| PUT | `/api/v2/watch-groups/{id}` | portfolio.write |
| DELETE | `/api/v2/watch-groups/{id}` | portfolio.write |
| POST | `/api/v2/watch-groups/{id}/icon` | portfolio.write |
| POST | `/api/v2/watch-groups/reorder` | portfolio.write |
| GET | `/api/v2/orders` | portfolio.read |
| POST | `/api/v2/orders` | portfolio.write |
| PUT | `/api/v2/orders/{id}` | portfolio.write |
| DELETE | `/api/v2/orders/{id}` | portfolio.write |
| GET | `/api/v2/funds` | portfolio.read |
| POST | `/api/v2/funds` | portfolio.write |
| DELETE | `/api/v2/funds/{id}` | portfolio.write |
| GET | `/api/v2/fire-settings` | portfolio.read |
| PUT | `/api/v2/fire-settings` | portfolio.write |
| GET | `/api/v2/simple-ledger` | portfolio.read |
| PUT | `/api/v2/simple-ledger` | portfolio.write |
| GET | `/api/v2/brokers` | portfolio.read |

### 4.4 动态

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v2/resource-library` | resources.read |
| GET | `/api/v2/resource-library/folders` | resources.read |
| POST | `/api/v2/resource-library/folders` | resources.write |
| DELETE | `/api/v2/resource-library/folders/{folderId}` | resources.write |
| GET | `/api/v2/resource-library/files` | resources.read |
| POST | `/api/v2/resource-library/files` | resources.write |
| GET | `/api/v2/resource-library/files/{fileId}` | resources.read |
| DELETE | `/api/v2/resource-library/files/{fileId}` | resources.write |
| GET | `/api/v2/resource-library/files/{fileId}/content` | resources.read |
| GET | `/api/v2/resource-library/uploads/{requestId}` | resources.read |
| GET | `/api/v2/resource-library/deletions/{requestId}` | resources.read |
| GET | `/api/v2/feed` | feed.read |
| GET | `/api/v2/feed/groups` | feed.read |
| POST | `/api/v2/feed/groups` | feed.write |
| PUT | `/api/v2/feed/groups/{groupId}` | feed.write |
| POST | `/api/v2/feed/subscriptions/test` | feed.write |
| GET | `/api/v2/feed/profile` | feed.read |
| PUT | `/api/v2/feed/profile` | feed.write |
| POST | `/api/v2/feed/profile/avatar` | feed.write |
| GET | `/api/v2/feed/jobs` | feed.read |
| PUT | `/api/v2/feed/preferences` | feed.write |
| POST | `/api/v2/feed/refresh` | feed.write |
| GET | `/api/v2/feed/jobs/{jobId}` | feed.read |
| GET | `/api/v2/feed/posts/{postId}` | feed.read |
| PUT | `/api/v2/feed/posts/{postId}` | feed.write |
| GET | `/api/v2/feed/posts/{postId}/discussion` | feed.read |
| POST | `/api/v2/feed/posts/{postId}/discussion` | feed.write |

### 4.5 行情与公开资源

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/v2/upload` | profile.write |
| GET | `/api/v2/assets` | public |
| GET | `/api/v2/assets/lookup` | public |
| GET | `/api/v2/celebs` | public |
| GET | `/api/v2/celebs/{id}` | public |
| GET | `/api/v2/celebs/{id}/returns` | public |
| POST | `/api/v2/quotes` | public |
| GET | `/api/v2/quote-subscriptions` | portfolio.read |
| POST | `/api/v2/quote-subscriptions` | portfolio.write |
| DELETE | `/api/v2/quote-subscriptions` | portfolio.write |
| POST | `/api/v2/charts` | public |
| GET | `/api/v2/kline` | public |
| GET | `/api/v2/index-kline` | public |
| GET | `/api/v2/kline-sessions` | public |
| GET | `/api/v2/stock-detail` | public |
| GET | `/api/v2/search` | public |
| GET | `/api/v2/earnings` | public |
| GET | `/api/v2/rates` | public |
| GET | `/api/v2/indices` | public |
| GET | `/api/v2/company-profile` | public |
| GET | `/api/v2/settings/public` | public |

不提供旧 Web 登录会话合同、Cookie 会话管理、管理员写入、备份/导入导出、财务报表或 portfolio-series。券商目录（brokers）仍需 portfolio.read，本地模式券商使用本地库。

## 5. 原生账户安全

下表所有端点相对于 `/api/v2/auth`；读取需要 security.read，管理需要 security.write。开启二次验证后 code 可为当前TOTP或一次性备用码。错误密码/因素为HTTP403，不注销连接。

- GET email-verification → {email,verified,canRequest}，需要 read。
- POST email-verification/request，空 JSON → {ok:true,verified:false,retryAfter:60}（已验证则 verified:true）。需要 write。邮件包含既有 HTTPS /verify-email?token=... 链接；发送不标记已验证。
- POST email-verification/confirm {token} → {ok:true,verified:true,user}，需要 write；token 必须属于 Bearer 用户，绑定现有邮箱/密码且一次性。原生请求发出的邮件正文会显示43字符 token，可复制到原生输入框；现有网页链接确认后 App 用 GET 刷新。
- GET totp → {enabled,name,backupCodesRemaining}，read，不返回密钥或已有备用码。
- POST totp/setup {currentPassword} → {challengeId,secret,otpauthUrl,qrPng,expiresAt}，write；临时挑战10分钟、绑定账户和 grant，未确认不启用。
- POST totp/confirm {challengeId,currentPassword,code,name?} → {ok:true,enabled:true,backupCodes,reauthenticationRequired:true}，write；code 是新验证器首个 TOTP；成功撤销所有 Web 会话和 App grant。先一次展示 backupCodes，再清除匹配旧连接。
- POST totp/disable {currentPassword,code} → {ok:true,enabled:false,reauthenticationRequired:true}，write；code 为现有 TOTP/备用码，成功撤销所有会话/授权。
- POST totp/backup-codes {currentPassword,code} → {ok:true,backupCodes,reauthenticationRequired:boolean}，write；原备用码全部失效，明文只本次返回；通常不失效当前 grant，旧明文因子迁移导致安全戳改变时返回 true，按真实状态处理。
- GET passkeys → {keys:[{id,name,rpID,createdAt,lastUsedAt,backedUp}],registration:{supported:false,rpID,origin,reason}}，read。
- DELETE passkeys {id,currentPassword,code?} → {ok:true,reauthenticationRequired}，write；删除本人密钥，同时撤销来自该密钥的 Web 会话/App grant，当前 grant 若来自此密钥返回 true。
- POST passkeys/register-options、POST passkeys/register-verify：当前明确返回 503/50301（关联域名未核验），不得调用系统注册或宣称已支持；未来启用须单独验证部署并约定挑战合约。
- GET security-devices → {devices:[{id,kind:"web"|"app",name,createdAt:number|null,lastUsedAt:number|null,expiresAt,current,scope?}]}，read；App id 为 grant_id，Web id 为不可用来认证的摘要标识，原生连接下所有 Web 项 current=false。不返回令牌/hash/IP。
- DELETE security-devices {id,currentPassword,code?} → {revoked:true,reauthenticationRequired}，write；缺/外用户 id 为404；撤销当前 grant 时 true，客户端只清匹配 origin/grant。既有 Cookie /auth/devices 保持兼容。

40101/40102 表示登录/会话失效；权限不足返回40301/HTTP403，客户端可提供显式重新授权；当前密码错误40103/HTTP403、因子错误40104/HTTP403，不能退出 App；挑战过期40902/HTTP409；参数40001、限流42901、内部50001。事务失败不消费因子、不提交部分安全变更。

### 5.1 公共密码恢复

- POST password-reset/request {login,challenge?} → {ok:true,challenge,retryAfter:60,message}，对未知账号、未验证邮箱、邮件服务不可用等使用一致回执与随机 challenge。仅已验证邮箱实际异步发送验证码，限流与共享邮件预算沿用 Web。challenge 不放 URL。
- POST password-reset/verify {challenge,code} → {ok:true,token,expiresAt}，错误统一40003，不泄露账号；最多5次，5分钟期限，一次性消费验证码。
- POST password-reset/confirm {token,newPassword} → {ok:true,reauthenticationRequired:true}，一次性恢复凭证与改密/撤销全部会话同事务。成功仅清除发起恢复时仍匹配的本地连接。弱密码不消费 token。token 不放 URL，不记录日志/缓存。

原生新增通行密钥当前不可用，registration.supported=false，reason=associated_domain_unverified；不要仅因 Web 可注册就调用系统注册。列表和删除可用。成功后按 reauthenticationRequired boolean 清除匹配 origin / grant / apiVersion 的旧连接，不清除已经换入的新连接。备用码明文只展示一次。

## 6. 投资与行情示例

<details>
<summary>记录与总资产</summary>

GET `/api/v2/records?page=1&pageSize=20&market=US` 返回本人数组与 meta={page,pageSize,total,collectionRevision}，pageSize 上限100。后续页携带首个 collectionRevision，集合变化返回40902，应从第一页只读重取，不能合并不同版本的分页。GET records/{id} 返回本人单条记录；记录新增正整数 revision，数值空值仍为 `""`。

安全提交须发现 `auth/config → data.records_contract.version=1`，按所选 v2 的固定路径使用；旧载荷与信封仍兼容。新 POST 示例：

```json
{"requestId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"苹果","code":"AAPL","market":"US","price":210.5,"cost":200,"qty":10,"group":"主账户","note":""}
```

PUT records/{id} 使用完整记录输入，另加 requestId 和读取到的 revision；DELETE 使用 JSON `{requestId,revision}`。price/qty 非负，cost 可为负数。记录、活动、集合版本与操作回执在同一事务提交；重复键返回40901、不再次写入，版本冲突40902，含成交历史的删除40903。安全提交成功 data 仍为已保存记录，DELETE 为 `{deleted:true,id,revision}`；meta={requestId,kind,recordId,revision,collectionRevision}。须核对回执再确认保存；失效401、有效连接缺范围403，旧 portfolio.write 授权可用、只读授权不自动扩大。

断开/超时/500 时仅 GET `/api/v2/records/operations/{requestId}` 查询。data={requestId,kind,recordId,state,code,message,record,deleted,revision,collectionRevision,createdAt,completedAt}；state=completed/failed，GET 成功不能当写成功。record 是原提交快照，删除时 null；404 仅为此刻没有已提交回执，不能断言无写入或自动重放。保持 v1/v2，不用 Cookie、刷新令牌或切版本重发写入；完整冻结字段见 [App 股票记录合约](app-records.md)。

App 与 Web records 为同账户同库。`GET /api/v2/search?q=...` 搜索已有证券，records 新增本人自选/持仓，不能新增全局证券目录；可选 watchGroupId 仅归属本人自定义组，group 是券商，qty 空/0 是自选、正数是持仓快照，不生成成交订单。

GET `/api/v2/overview?currency=USD` 返回持仓估值、现金与总资产。totalMarket 是持仓市值；totalAsset 包含现金。缺汇率或来源异常时金额可为null，并返回完整性与缺失币种，不能按1:1换算。

GET fire-settings → data={fire}；PUT 请求 `{fire,assetRecord?}` → data={ok:true,assetHistory}。v1 此资源的历史裸JSON仍保留，v2使用统一信封。simple-ledger 返回账本 data，PUT 部分字段合并；这些端点都共用本人数据。

</details>

<details>
<summary>批量行情与素材</summary>

POST `/api/v2/quotes` 或 charts，批量 items 最多100只：

```json
{"items":[{"id":"US:AAPL","market":"US","code":"AAPL"}]}
```

quotes data={quotes:{证券ID:报价}}，charts data={charts:{证券ID:分时}}。行情保持原币种金额、source / coverage 与缺失状态，不生成假报价。

GET `/api/v2/assets` 或 assets/lookup 读取目录/匹配图标。POST upload 只用于明确 profile.write 的本人头像，不开放公共素材管理员写入；multipart kind=avatar、file，最大5MiB并校验内容。图片URL按当前origin解析，公开资源不会授予个人资料权限。

</details>

### 用户行情订阅（v2）

两版 `auth/config` 的 `quote_subscriptions_contract` 声明固定 `/api/v2/quote-subscriptions`、读写 scope、支持市场、单次100只、每用户256只、七天空闲到期和90秒热需求。客户端先检查该能力；自动登记行情读取不需要额外请求。历史 K 线、分时、`stock-detail?view=history` 和订阅列表查询不登记或续期。

| 操作 | 请求 | 效果 |
| --- | --- | --- |
| 查看 | GET `/api/v2/quote-subscriptions`，可选 `?market=HK` | 仅返回本人未到期订阅，不续期 |
| 订阅/续期 | POST `/api/v2/quote-subscriptions`，`{"items":[{"market":"HK","code":"700"}]}` | 规范代码去重，更新本人期限，立即具备入池资格 |
| 取消部分 | DELETE 同路径，`{"items":[{"market":"HK","code":"00700"}]}` | 只移除本人所列需求 |
| 清空本人 | DELETE 同路径，`{"all":true}` | 只移除本人全部需求 |

只接受 App Bearer；GET 需 `portfolio.read`，POST/DELETE 需 `portfolio.write`，不增加旧授权范围。证券支持 US/HK/CN/JP/KR/ASSET；请求不携带记录ID、用户ID或金额，未知字段/市场/无效代码/超过100只为400，超过64KiB为413，超出本人256只为409且整批不写入。自动登记超过本人容量时只淘汰本人的最久未读订阅，不阻塞行情读取。

成功 `data={subscriptions:[{market:"HK",code:"00700",lastRequestedAt:1791014890000,expiresAt:1791619690000,state:"hot"}]}`；时间为 Unix 毫秒，`state` 为最近90秒仍有需求的 `hot` 或保留但暂停主动读取的 `dormant`，不代表报价新鲜度、交易所正在开市或强制实时推送。响应 `no-store, private`，不含其他订阅者及用户账户信息。

每个用户分别以最后真实请求时间计算七天期限，后台更新与列表查询不续期。取消、到期及删除账户只释放本人需求，其他用户或匿名读者仍需该证券时继续保留共享报价；取消不改变持仓、自选、订单或资金，下次实际行情读取会重新登记。已开始的共享报价读取允许完成，但结果不会重新创建已取消的订阅。订阅与到期清理持久化；重启后第一次认证需求恢复未过期条目，休眠证券不会因恢复而批量读取上游。共享调度仍限当前服务进程，多个服务器尚不统一源站任务。

### 6.1 个股详情

个股详情页（moomoo 风格：头部行情 + 4 列指标 + 多币种市值 + K 线）的数据统一走该接口，
Web 前端与 iOS App 消费同一份数据，移动端**无需自行做币种换算 / K 线聚合**。

### 请求

`GET /api/v2/stock-detail?market=US&code=AAPL`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `market` | 是 | 市场代码：`US` / `HK` / `CN` / `JP` / `KR` |
| `code` | 是 | 股票代码（如 `AAPL`、`00700`、`600519`），仅允许字母数字 `._-` |

### 响应示例

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "market": "US",
    "code": "AAPL",
    "name": "AAPL",
    "currency": "USD",
    "quote": {
      "name": "AAPL",
      "price": 313.33,
      "change": 0.92,
      "changePct": 0.29,
      "open": 311.45,
      "high": 314.81,
      "low": 310.74,
      "prevClose": 312.41,
      "volume": 34437191,
      "amount": 10776446647,
      "pe": 35.93,
      "turnover": 1.3,
      "marketCap": 4569952165000,
      "time": "2026-08-07 16:00:01"
    },
    "marketCap": {
      "USD": 4569952165000,
      "HKD": 35850817739208.5,
      "CNY": 30836209228554,
      "SGD": 5853651728148.5,
      "JPY": 723606225806100,
      "KRW": 6470823768031750
    },
    "rates": { "USD": 1, "HKD": 0.1275, "CNY": 0.1482, "SGD": 0.7807, "JPY": 0.0063, "KRW": 0.0007 },
    "kline": [
      { "d": "2026-08-07", "o": 311.45, "h": 314.81, "l": 310.74, "c": 313.33, "v": 34437181 }
    ]
  }
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `quote` | 实时行情（腾讯 / 新浪，含今开 / 最高 / 最低 / 昨收 / 成交量 / 成交额 / 市盈率 / 换手率 / 总市值）；暂无行情时 `null` |
| `marketCap` | 六币种市值（`USD` / `HKD` / `CNY` / `SGD` / `JPY` / `KRW`），本地币种为原始市值，其余按汇率换算；无市值（如部分 ETF）时为 `null` |
| `rates` | 对 USD 的汇率（缓存 + 兜底，见 `/api/v2/rates`） |
| `kline` | 日 K（前复权）：`d` 日期 `YYYY-MM-DD`、`o` 开、`h` 高、`l` 低、`c` 收、`v` 量（A股为手，其余为股）；美股 Yahoo 日线（拆股复权）→ 新浪兜底；港股 A股 日韩腾讯 fqkline，A股可兜底东财；少量基准优先富途，10 分钟缓存，最多 320 条 |

完整详情并行读取行情、汇率、K 线，响应等待三路结束；任一路失败只缺对应字段（`quote: null` / `marketCap: null` / `kline: []`），HTTP 仍返回 `code: 0`。

历史曲线使用 `GET /api/v2/stock-detail?market=US&code=AAPL&view=history`，仅返回 `{ market, code, kline }`，跳过实时行情、汇率及 ETF 市值查询。失败返回 HTTP 502 / `50002`，可立即重试。旧容器忽略 `view` 后仍返回完整详情，客户端只读取其中 `kline`，无需新增授权或切换连接。`includeKline=0` 继续用于完整详情的行情读取；`view=history` 时优先返回历史。

月收盘 `/api/v2/kline` 与旧版 `/api/kline` 共用同一数据与缓存；旧版保持 `{ closes }` 并截取最近 12 个月。两者使用规范化代码、有界缓存和在途请求合并；美股并行探测交易所，首个有效结果取消剩余探测，失败继续腾讯兜底。腾讯月线取收盘列而非开盘列；月份升序、去重并与价格一一对应。上游不可用或返回空历史时为 HTTP 502 / `50002`。
周 / 月 K 由客户端对 `kline` 聚合（周：ISO 周首日开 / 末日收 / 高低取极值；月：自然月同理）。

### 6.2 公司简况

Web“公司”页与 iOS App 共用同一份公司资料契约。

### 请求

`GET /api/v2/company-profile?market=US&code=AAPL`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `market` | 是 | 当前首版支持 `US`；其他市场返回 `supported: false` |
| `code` | 是 | 股票代码，仅允许字母数字 `._-` |

### 响应示例

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "supported": true,
    "source": "SEC EDGAR",
    "company": "Apple Inc.",
    "symbol": "AAPL.US",
    "exchange": "纳斯达克全球精选市场",
    "founded": "1976",
    "industry": "电子计算机",
    "fiscalYearEnd": "9 月 26 日",
    "website": "https://www.apple.com/",
    "description": "苹果公司设计、制造和销售智能手机……",
    "address": "ONE APPLE PARK WAY, CUPERTINO, CA, 95014",
    "phone": "(408) 996-1010"
  }
}
```

资料按公司缓存 24 小时。`website`、`address`、`phone` 可能为空字符串；无法覆盖的成立年份返回 `—`。

### 6.3 分时走势

供 Web 行情板、持仓列表和 iOS 迷你走势图共用。一次最多请求 100 只股票，服务端会按市场选择数据源，并在主数据源缺失时自动回退；单只股票无数据不会导致整批请求失败。

### 请求

`POST /api/v2/charts`

```json
{
  "items": [
    { "id": "US.AAPL", "market": "US", "code": "AAPL" },
    { "id": "HK.00700", "market": "HK", "code": "00700" },
    { "id": "CN.600519", "market": "CN", "code": "600519" }
  ]
}
```

`id` 由客户端定义，并原样作为 `charts` 的键；建议使用稳定的 `市场.代码` 格式。`market` 支持 `US`、`HK`、`CN`、`JP`、`KR`、`SG` 等标准市场代码。

证券代码必须按字符串传递并保留前导零：A 股使用六位代码（如世纪华通 `002602`、五粮液 `000858`），港股建议使用五位代码（如腾讯 `00700`）。该规则也适用于 `/api/v2/quotes`，iOS 不应先把代码转换为整数。

迷你图可在请求体增加 `"sample": true`，每只证券最多返回 60 个点，保留首尾与分桶高低点；用于列表预览，不用于计算组合资产或详细分析。不传或为 `false` 时保留完整分时。旧容器忽略该字段时仍可解码完整图。客户端缓存必须区分完整图／迷你图及真实／演示来源。

### 响应示例

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "charts": {
      "HK.00700": {
        "date": "20260811",
        "points": [
          { "time": "09:30", "price": 552.5, "volume": 128400 }
        ]
      }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `date` | 数据所属交易日；上游可能返回 `YYYYMMDD` 或 `YYYY-MM-DD`，客户端展示前应统一格式化 |
| `points[].time` | 交易所当地时间，格式 `HH:mm` |
| `points[].price` | 最新/收盘价 |
| `points[].volume` | 当前分钟成交量；上游缺失时为 `0` |

数据策略：

- 美股直接读取含扩展时段的 1 分钟行情，覆盖盘前、盘中、盘后（04:00–19:59，美东时间）。
- 港股、A 股优先读取主行情源；单只证券缺失时自动回退备用 1 分钟数据源。
- 日股、韩股、新加坡股在主源不支持时也会尝试对应交易所的备用代码。
- 未获取到走势的证券不会出现在 `charts` 中；iOS 应保留旧缓存或显示暂无走势，不要把整批响应视为失败。

批量行情 `/api/v2/quotes` 与旧 `/api/quotes` 可传 `"includeMarketCap": false`，跳过额外的 ETF 份额／基金规模补全；已有上游市值仍会返回。省略该字段保持完整报价，供个股详情和 ETF 排序使用。ETF 份额成功缓存 24 小时、失败冷却 6 小时；并发相同代码共用读取，市值按各调用者现价计算，单次补全最多访问 12 个不同证券。

`/api/v2/quotes` 和 `/api/v2/charts` 在客户端接受 gzip 且响应至少 1 KB、压缩可缩小时异步压缩，正确处理 `gzip;q=0`；信封和字段不变。响应为 `Cache-Control: no-store, private` 与 `Vary: Accept-Encoding`，请求 ID 不进入 HTTP 共享缓存，公开市场值只在服务端按证券共享。URLSession／浏览器自动解压。

超过 100 只应拆为最多两个同时进行的滚动批次。网络、限流或上游失败只影响本批，其他批继续返回。App 保留失败批的有效旧值，公开价格回退最长 10 分钟、分时最长 30 分钟，过期／上游旧图不续期；取消、来源切换、证书及权限错误直接结束，不用旧值掩盖。网页失败批保留原价，首帧快照与在途返回都校验记录 ID 对应的市场和代码，修改证券后不会恢复原证券的报价；后台停止未完成的读取。

服务端分时缓存 30 秒，行情结果共享 2 秒。列表页建议只请求当前可见证券（Web 当前每页 6 只）；iOS 前台活跃时建议每 30 秒刷新分时，进入后台或非交易时段停止轮询。

v1/v2 共用按市场分开的公共行情池。已认证的批量报价、资产总览和完整个股详情读取会自动登记本人证券需求；同一请求的重复记录与代码别名只计一次，第二次独立请求后入池。最近90秒仍有读取时按市场独立调度（现有时段判断为活跃时目标五秒，午休/闭市/周末六十秒，加密货币十秒），无人读取后休眠，下次读取恢复；连续七天无人请求自动释放，后台更新不续期。每市场独立最多256个活跃条目、一个在途批次、每批20只，首次/待准入需求最多1024只；容量满时优先释放同市场最久未读的休眠条目。公共报价池只保留市场和规范代码，价格不持久化，不共享用户持仓或账户金额。本人订阅存入私有数据库，首次认证行情或订阅读取恢复未到期需求；匿名需求仍为进程内记录。

七天是需求保留期限，不是报价有效期。活跃市场最多十秒、闭市最多六十秒、加密货币最多十五秒的同一时段池快照可先返回；其中超出两秒共享缓存的报价带可选 `cached:true`，保留真实 `time/source/session`，超龄或时段改变继续正常读取。总览的 `quoteStatus.cached` 包含这些记录，`pending` 包含已到期排队或进行中的池更新；原有一分钟总览兜底与缺失状态保持。市场时段判断不推断节假日或临时停市，实际报价时间仍以源数据为准。完整规则见 [资产总览与活跃行情池](api-spec.md)。

- **交易日**：按交易所当地日期计算。美股使用 `America/New_York`，港股与 A 股使用 `Asia/Shanghai`，不按设备时区切换。
- **单股盈亏**：`(最新价 - 昨收价) × 持仓数量`。
- **跨市场汇总**：先按本币计算，再用当前汇率换算到展示币种。
- **刷新**：首次拉取全部市场快照；之后在对应市场盘前、盘中、盘后及可用的美股夜盘每 30 秒刷新。进入后台或非交易时段停止轮询，保留最后有效值。

美股仍以**美东时间 20:00**归档前一盈亏周期；接着开始的20:00–04:00夜盘归入下一盈亏交易日期，跨午夜保持同一夜盘周期。预期夜盘从周日至周四晚开始，周五20:00后保持已结算至周日晚20:00；节假日及实际报价可用性另行核对，不以时钟标签认定实时开市。不得使用中国时间20:00或设备本地午夜切换美股盈亏日期。

- **返回字段**：`price`、`change`、`changePct` 为采用来源的报价与涨跌；来源可确认时附 `session: PRE | REGULAR | AFTER | OVERNIGHT` 及 `prevClose`。客户端按实际返回时段与时间判定，不能用请求时段重标报价。
- **涨跌基准**：`prevClose` 与 `change` 属于同一口径。盘前使用最近常规收盘；常规盘及盘后保留当日相对前一常规交易日收盘的涨跌；夜盘用富途实际 `overnight_change_val` 反推 `prevClose = price - change`，即该周期20:00前最近常规收盘，不借旧 `prev_close_price`。0涨跌仍是有效报价。
- **来源时间**：原样保留，支持秒和1–9位小数秒，例如 `2026-10-01 23:36:54.780`。无时区的美股时间按 `America/New_York` 解析；带偏移的ISO时间按其偏移解析，不按中国日期直接匹配夜盘盈亏日期。
- **夜盘回退**：富途只有同周期且具备实际夜盘价与涨跌基准才标记 `OVERNIGHT`；旧字段、缺字段或无效时间时保留原常规价、原时间及 `REGULAR`。当前Yahoo盘前/盘后图表的20:00末根点不算夜盘；其常规价只采用配对的 `regularMarketTime`，缺时间留空。
- **客户端**：两版行情共用服务和上述字段。缺少可确认的当期报价时继续保留持仓，本期金额显示 `—`，不填0、不隐藏股票、不用旧价算本期夜盘收益。个股夜盘可用性不同，完整规则见 [夜盘报价交接](overnight-quotes.md)。

美股 K 线会先规范化交易所后缀（例如 `SPCH.AM → SPCH`）。日 K 首选新浪，空数据时自动回退 Yahoo 日线；5 日分钟线同样在新浪缺失时回退 Yahoo 5 分钟线。客户端只消费统一的 `items` / `points`，无需识别上游，适用于新上市 ETF 与美交所证券。

### 6.4 K 线时段

返回美股最近交易日 1 分钟分时数据，时间均为**美东时间**。Web 和 iOS 可按 `session` 字段直接筛选，无需自行推断时段。

### 请求

`GET /api/v2/kline-sessions?market=US&code=AAPL`

### 响应示例

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "market": "US",
    "code": "AAPL",
    "source": "Yahoo Finance extended hours",
    "coverage": {
      "pre": "04:00-09:29",
      "regular": "09:30-16:00",
      "after": "16:01-19:59",
      "overnight": false
    },
    "points": [
      { "date": "2026-08-07", "time": "09:30", "price": 311.45, "volume": 120451, "session": "REGULAR" }
    ]
  }
}
```

| `session` | 时间范围（美东） | 说明 |
| --- | --- | --- |
| `PRE` | 04:00–09:29 | 盘前 |
| `REGULAR` | 09:30–16:00 | 盘中 |
| `AFTER` | 16:01–19:59 | 盘后 |
| 夜盘 | 20:00–03:59 | 当前数据源暂不提供，`coverage.overnight=false` |

行情缓存 30 秒。夜盘暂不返回伪数据；iOS 应根据 `coverage.overnight` 将夜盘入口置灰。

### 6.5 自选股分组

自选股分组为服务端独立实体（`watch_groups` 表），记录通过 `watch_group_id` 归属，券商仍走 `records.group_name`（持仓显示），两者彻底解耦；Web 与 iOS 共享同一份分组数据。

### 分组模型

| 字段 | 说明 |
| --- | --- |
| `id` | 分组 id（`wg-*`） |
| `name` | 显示名称（市场分组可重命名，自定义分组重命名即时生效） |
| `icon` | 分组图标 URL（自定义分组相机上传，同时注册素材库 `type=group` 防清理丢失） |
| `sort` | 展示顺序（`reorder` 批量写入） |
| `visible` | `-1` 自动（空分组隐藏）/ `0` 隐藏 / `1` 显示 |
| `kind` | `market` 内置市场分组（美股/港股/A股/新加坡/日股/韩股，不可删除，动态按市场过滤） / `custom` 用户自定义 |
| `market` | `kind=market` 时的市场代码 |

### 接口示例

**GET /api/v2/watch-groups** —— 列表（首次访问自动播种市场分组 + 迁移旧数据；`sort` 升序）
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "groups": [
      { "id": "wg-abc123", "name": "美股", "icon": "", "sort": 0, "visible": -1, "kind": "market", "market": "US" },
      { "id": "wg-def456", "name": "科技", "icon": "/uploads/asset/group/科技.png", "sort": 6, "visible": -1, "kind": "custom", "market": "" }
    ]
  }
}
```

**POST /api/v2/watch-groups** —— 新建自定义分组
```json
// 请求体
{ "name": "核心持仓" }
// 成功响应（重复名称返回 40901「分组已存在」）
{ "code": 0, "message": "ok", "data": { "group": { "id": "wg-xyz789", "name": "核心持仓", "icon": "", "sort": 7, "visible": -1, "kind": "custom", "market": "" } } }
```

**PUT /api/v2/watch-groups/{id}** —— 更新（字段可选：`name` 重命名 / `icon` 图标 / `visible` 显隐）
```json
// 请求体：重命名 + 显隐
{ "name": "核心持仓", "visible": 1 }
// 请求体：上传 / 清除图标（icon 传空字符串 = 清除）
{ "icon": "/uploads/asset/group/科技.png" }
// 成功响应
{ "code": 0, "message": "ok", "data": { "group": { "id": "wg-xyz789", "name": "核心持仓", "icon": "", "sort": 7, "visible": 1, "kind": "custom", "market": "" } } }
```

**DELETE /api/v2/watch-groups/{id}** —— 删除自定义分组（清空记录归属 + 图标素材；市场分组返回 40001「市场分组不可删除」）
```json
{ "code": 0, "message": "ok", "data": { "deleted": true } }
```

**POST /api/v2/watch-groups/reorder** —— 整体排序（body 传全量分组 id，按数组顺序写入 `sort`）
```json
// 请求体
{ "order": ["wg-abc123", "wg-xyz789", "wg-def456"] }
// 成功响应
{ "code": 0, "message": "ok", "data": { "updated": 3 } }
```

**POST /api/v2/records/group-assign** —— 批量分配 / 移出分组
```json
// 请求体（groupId 传空字符串 = 移出分组；仅可分配到 custom 分组）
{ "ids": ["r-001", "r-002"], "groupId": "wg-xyz789" }
// 成功响应
{ "code": 0, "message": "ok", "data": { "updated": 2 } }
```

**约定**
- 全部接口需登录（`Authorization: Bearer fat_<App access token>` ，不接受 Cookie），未登录返回 `40101`；限流 `42901`。
- 分组数量（count）由客户端用记录计算：市场分组 = `records.market` 匹配数，自定义分组 = `watch_group_id` 匹配数，接口不额外返回。
- 分组图标上传：`POST /api/v2/watch-groups/{id}/icon`（multipart `file`），返回 `{ code: 0, data: { group } }`。服务端校验登录、分组归属及图片内容，完成图标存储和素材注册；不需要再次 PUT。公共素材上传仍仅管理员可用。
- 素材库「分组图标」分类只展示非券商自定义分组（有 `type=broker` 同名图标的券商分组走「券商图标」分类）。

### 行为约定

- 添加股票自动进入「全部 + 对应市场」；市场分组是动态过滤（按 `records.market`），自定义分组才是显式归属（按 `records.watch_group_id`）。
- 删除自定义分组：清空该分组下所有记录的 `watch_group_id`（一条 SQL），并删除图标素材。
- 旧版 `?filter=G:名称` / `M:US` URL 自动迁移到分组 id；分组不存在时回退「全部」。
- 旧 localStorage 分组配置（`fire:watch-groups:v1`）首次加载时一次性同步到服务端并清除。

### 6.6 交易与订单

订单是可审计的成交凭证；持仓记录是订单执行后的最新快照。普通交易只追加订单，录入错误通过专用更正接口修改并重算账本。Web 的持仓一级页只展示组合，点击股票进入二级详情后再执行交易、查看该股票订单。iOS 可直接复用以下接口。

订单录入错误可通过 `PUT /api/v2/orders/{id}` 留痕更正。服务端会按成交时间重放该股票全部已成交订单，重新计算每笔成交后的数量、成本、已实现盈亏以及当前持仓；若更正后任意时点出现超卖，则整次修改回滚并返回 `40001`。

### 查询单只股票订单

```http
GET /api/v2/orders?recordId=r-aapl&scope=today&limit=200
Authorization: Bearer fat_<App access token>
```

- `scope=today`：按 `tradedAt`（成交时间）归入本地时区当日成交；`history`：按成交时间早于当日；`all`：全部（默认）。`createdAt` 仅表示订单记录写入时间，不参与“当日订单”归类。
- `recordId` 可选；传入后只返回当前用户该条持仓的订单。
- `limit` 为 `1...5000`，默认 `200`。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "scope": "today",
    "recordId": "r-aapl",
    "orders": [{
      "id": "o-123",
      "recordId": "r-aapl",
      "market": "US",
      "code": "AAPL",
      "name": "苹果",
      "side": "buy",
      "status": "filled",
      "qty": 10,
      "price": 210.5,
      "fees": 1,
      "amount": 2105,
      "realizedPnl": null,
      "positionQtyBefore": 20,
      "positionCostBefore": 192.05,
      "positionQtyAfter": 30,
      "positionCostAfter": 198.366667,
      "broker": "长桥证券",
      "note": "分批建仓",
      "tradedAt": "2026-08-12T02:30:00.000Z",
      "createdAt": "2026-08-12T02:30:01.000Z"
    }]
  }
}
```

### 执行交易

```http
POST /api/v2/orders
Content-Type: application/json
Authorization: Bearer fat_<App access token>

{
  "recordId": "r-aapl",
  "side": "sell",
  "qty": 5,
  "price": 220,
  "fees": 1.5,
  "tradedAt": "2026-08-12T10:30:00.000Z",
  "note": "分批止盈"
}
```

成功返回 `{ order, position }`。

| 项目 | 计算规则 |
| --- | --- |
| 买入成本 | 按原持仓成本额、本次成交额与费用加权 |
| 卖出后成本 | `(卖出前数量 × 卖出前成本 − 卖出数量 × 成交价) ÷ 剩余数量` |
| 已实现盈亏 | `(成交价 - 卖出前成本) × 数量 - 费用` |
| 精度 | 成交后成本保留 3 位小数，后续持仓盈亏使用该可见成本 |

- 卖出采用摊薄 / 保本成本：亏损卖出提高剩余成本，盈利卖出降低成本，累计回款超过投入时可为负数。
- 卖出费用仅计入已实现盈亏，不重复计入剩余成本。
- 订单返回 `positionQtyBefore`、`positionCostBefore` 及成交后快照，供审计与重放。
- 超卖返回 `40001`；订单写入与持仓更新在同一数据库事务内完成。

### 删除历史订单

```http
DELETE /api/v2/orders/o-123
Authorization: Bearer fat_<App access token>
```

成功返回 `{ deletedId, position }`。服务端删除目标订单后，会从该股票第一笔成交前的基准持仓开始重放剩余订单，重新计算每笔订单快照和当前持仓；若删除会令后续任一卖出订单超卖，则整次删除回滚并返回 `40001`。该操作不可撤销，客户端应仅在历史订单页提供，并在执行前二次确认。

---

## 7. 动态与分页

feed.read读取本人帖子和分组，feed.write管理分组、订阅、指示、生成、喜欢/隐藏和讨论。两版发现新增可选 `feed_contract:{version:1,groups_path,subscriptions_test_path}`；路径使用被选择版本，修订号不改变API版本。完整冻结合约见 [App新闻动态](app-feed-news.md)，App本轮只选news组，不纳入people原帖；default也可能是people，先读groups再选择。

GET feed 的 limit=1–50，cursor 为不透明游标；资金列表使用 limit / offset，记录使用 page / pageSize，不能把所有接口当同一种分页。POST feed/groups `{name,mode:"news"}` 新建；PUT feed/groups/{groupId} `{name,revision}` 改名并保留指示、订阅、开关和间隔。POST feed/subscriptions/test `{name,url}` 只测试公开RSS/Atom，不保存；实际订阅通过当前组preferences保存，最多8项。

PUT feed/preferences：`{instructions,revision,enabled?,intervalMinutes?}`，revision冲突HTTP409；POST feed/refresh 空JSON启动任务，读取 jobs/{jobId} 的状态，完成后再读取帖子。POST posts/{postId}/discussion：`{text}`，1–2000字符，失败不保存半个讨论。

jobId 格式 fj- 加24位小写hex，postId 格式 fp- 加24位小写hex。读取后只应用仍匹配 origin / grant / apiVersion 的结果，离开页面或进入后台暂停轮询；超时写入结果不确定时先重新读取，不重发写请求。

## 8. 兼容与接入检查

- 旧连接保持v1，新 App 连接固定使用v2，服务器不支持时提示升级；旧客户端和浏览器继续使用原接口。
- auth/me 的 data 直接是 User；scope 与 capabilities 反映实际 grant，不因版本号自动开启安全编辑。
- 需要 profile/feed/security 写权限时明确重新授权；不要根据账号管理员角色放大 App 能力。
- 金额、订单、资金、汇率与分页业务含义沿用现有服务。同一账号在Web与App读取同源数据。
- HTTP返回不能证明已部署所有版本；先读取实际发现，不向发现字段给出的任意地址发送凭据。


## 9. 三地全年休市日历

新增 App 功能统一使用 v2；休市日历没有 v1 端点。Web 与 API 共用 `lib/marketCalendar.ts` 的年度安排，不建立另一套账户或行情数据。

### 请求和认证

- 单市场：`GET /api/v2/market-calendar?market=US&year=2026`
- 三市场批量：`GET /api/v2/market-calendar/batch?year=2026`

- 单市场接口 `market` 必填，精确大写 `CN` / `HK` / `US`，不可重复。
- `year` 必填，四位整数 2000–2100，不可重复；仅 2026 已核实。合法但未收录年份返回 HTTP 200、未知覆盖状态，不猜测交易日。
- 批量接口仅需 `year`，固定返回 US/HK/CN，传入 market 或 markets 返回参数错误；不提供 v1 批量端点。
- 两个接口均公开只读，可匿名调用，无新增 scope。Cookie 不提供身份；显式 Bearer 必须是有效 App access token。异源 Origin、无效 Bearer 即使携带缓存校验也拒绝。
- 错误使用 `{code,message}`：参数错误 HTTP 400 / 40001；认证、来源沿用 v2 规则。仅 GET，其他方法不支持。
- `GET /api/v1/auth/config` 和 `/api/v2/auth/config` 的 `data.market_calendar` 均以 path 指向固定 `/api/v2/market-calendar`，batch_path 指向固定 `/api/v2/market-calendar/batch`，包含 `api_version:2`、`access:"public"`、schema/data 版本、市场、时区、交易所和 verified_years。


#### auth/config 能力字段完整示例

以下 JSON 是 `data.market_calendar` 对象本身，两版 auth/config 使用同一对象，字段名与类型保持一致。`markets` 为数组；`schema_version` / `api_version` 为整数；`calendar_version` 为字符串；`verified_years` 为整数数组。

```json
{
  "path": "/api/v2/market-calendar",
  "batch_path": "/api/v2/market-calendar/batch",
  "api_version": 2,
  "access": "public",
  "schema_version": 1,
  "calendar_version": "2026-10-02.1",
  "markets": [
    {
      "market": "CN",
      "name": "A 股（沪深）",
      "time_zone": "Asia/Shanghai",
      "exchanges": [
        "SSE",
        "SZSE"
      ],
      "verified_years": [
        2026
      ]
    },
    {
      "market": "HK",
      "name": "港股",
      "time_zone": "Asia/Hong_Kong",
      "exchanges": [
        "SEHK"
      ],
      "verified_years": [
        2026
      ]
    },
    {
      "market": "US",
      "name": "美股",
      "time_zone": "America/New_York",
      "exchanges": [
        "NYSE",
        "NASDAQ"
      ],
      "verified_years": [
        2026
      ]
    }
  ],
  "temporary_closures": "unknown"
}
```

### 响应

成功为 `{code:0,message:"ok",data:{...}}`（message 仅展示，不用它判断状态）。data 完整字段：

| 字段 | 含义 |
|---|---|
| schemaVersion | 整数，当前 1；字段结构版本，区别于接口 v2 |
| calendarVersion | 字符串，当前 `2026-10-02.1`；数据修订版本 |
| market / marketName | 市场代码与展示名称 |
| timeZone / year | IANA 市场时区与所请求年份 |
| coverage | status=verified/unknown、from/to、verifiedYears、exchanges、verifiedAt（未知年份 null）、basis=official_annual_schedule、temporaryClosures=unknown |
| sources | id、title、url、publishedAt（无官方日期则 null）、verifiedAt；未知年份为空数组 |
| days | 全年按当地日期升序的每一天，包括周末；闰年 366 天 |

`days` 的单日示例（港股半日市）：

```json
{
  "date": "2026-12-24",
  "weekday": 4,
  "isWeekend": false,
  "status": "half_day",
  "isTradingDay": true,
  "name": "圣诞节前夕",
  "reason": "official_schedule",
  "actualTradingStatus": "unknown",
  "close": {
    "continuous": "12:00",
    "auction": {"earliest":"12:08","latest":"12:10","appliesTo":"CAS_securities"}
  },
  "sourceIds": ["hkex-2026","hkex-hours"]
}
```

- `date` 是交易所当地日历的 `YYYY-MM-DD` 字符串，不是 UTC 午夜时间戳。`weekday` 为 0=周日至6=周六，`isWeekend` 仅陈述星期事实，不能替代 status。
- status：trading=年度计划交易日；weekend=周末休市；holiday=节假日休市（与周末重合时优先）；half_day=计划半日市；unknown=未确认。
- isTradingDay：trading/half_day 为 true；holiday/weekend 为 false；unknown 为 null。name 为节日/半日市名称或不确定说明，其他为 null。
- reason 为 official_schedule / unverified_year / temporary_uncertainty；若维护时确认某天安排存在临时不确定性，unknown 覆盖年度安排，isTradingDay=null、close=null。当前没有临时停市信息流。
- **所有 actualTradingStatus 都是 unknown**。这是年度计划，不是当前开市检测；coverage.temporaryClosures=unknown。不要将 trading 解释为正在交易，不据此判断个股停牌。
- close 仅半日市有值。US continuous=13:00、auction=null，时区 America/New_York，夏令时由 IANA 规则处理。HK continuous=12:00；CAS 适用证券随机在12:08–12:10结束，不能把12:10当作所有证券的固定收市。CN 无半日安排。其他状态 close=null。
- sourceIds 对应 sources.id；未知年份 sources/sourceIds 均为空，即使日期落在周末也不宣称其已核实休市。

### 三市场批量响应

同样使用 `{code:0,message:"ok",data}`。`data` 字段：

| 字段 | 类型 / 含义 |
|---|---|
| schemaVersion | 整数，当前 1 |
| calendarVersion | 字符串，年度数据修订版本，与单市场相同 |
| year | 整数，所请求年份 |
| calendars | 对象，固定含 US / HK / CN 三个键，每个值是上文定义的完整 MarketCalendar，与对应单市场接口 data 深度一致 |

访问方式为 `data.calendars.US.days`、`data.calendars.HK.days`、`data.calendars.CN.days`，每个市场保留自己的 `market`、`timeZone`、`coverage`、`sources`、`days`。批量不会把所有日期混为一个 days 数组。未知年份的三个对象均保持 coverage.status=unknown、isTradingDay=null。

“全部”视图优先一次请求批量；收到后按市场拆入年度缓存。切到单市场可复用同一市场对象，无须再次请求。若批量端点尚未部署，明确检测后并行读取三个单市场端点，禁止退回 v1 或以批量失败猜测休市。

批量返回同一年度数据版本下的完整三市场实体，没有部分成功格式。认证和缓存规则与单市场相同，无新增 scope。

### 缓存与 iOS 使用

HTTP `Cache-Control: public, max-age=300, must-revalidate`，`ETag` 含 schemaVersion/calendarVersion/请求模式/市场/年份，单市场和批量及不同年份互不混用，`Vary: Origin, Authorization`。发送 If-None-Match 可返回无正文304，保留缓存实体；请求参数、数据修订或 schema 变化必须区分缓存。错误不缓存。

缓存键至少包含站点 origin / API v2 / 请求模式 / market / year；批量实体另外以 batch / year 保存，不能把单市场的 ETag 复用于批量；返回仅应用到仍匹配请求上下文的日历。iOS 自行使用原生模型，不导入 Web TypeScript 模块。点选市场时只展示该市场，优先复用缓存，无缓存再请求；用户选择「全部」时按相同当地 date 字符串汇总三份数据，保留每个市场自己的状态、时区与来源；休市用所选市场图标、half_day 加金色圆点、unknown 显示紫色圆点及未确认。年切换及快速连点不能显示上一年的旧结果。

保持现有纽约时间20:00盈亏归档周期及业务规则。日历仅辅助识别计划休市，不改持仓、账本、盈亏计算或报价新鲜度判断；未知安排不自动触发业务写入。

### 核实范围与来源

首版覆盖 2026 年 SSE / SZSE 现货股票（A 股沪深，不含北交所）、SEHK 证券市场、NYSE / Nasdaq 常规现金股票交易。不覆盖期权、盘前盘后、个股停牌及临时停市。

- [上交所休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/)
- [深交所2026年安排](https://www.szse.cn/disclosure/notice/general/t20251222_618087.html)
- [HKEX 2026年安排](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf)
- [HKEX 证券交易时段](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market)
- [NYSE 交易假期](https://www.nyse.com/trade/hours-calendars)
- [Nasdaq 交易假期](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule)

2026 计划交易天数（含半日）：沪深242、港股247（半日3）、美股251（半日2）。美股7月2日正常，7月3日休市；民用调休补班周末不转成交易日。

后续年度须逐交易所核对后登记，并提高 calendarVersion；结构不兼容时提高 schemaVersion。首版只支持一个已核实年度，切换其他年份明确显示未知。

### Web 与 App 的市场选择

单市场请求必须指定单个 `market=US`、`HK` 或 `CN`，响应中的 `data.market` 和全部 `days` 只属于该市场，不混入另一个市场的休市或半日市。切换市场时复用对应市场年度缓存，无缓存再请求；状态筛选由客户端依据 `days[].status` 完成，年度 API 保留完整日期网格。

Web 示例：`/global?section=calendar&market=HK&month=2026-12&status=half_day`。`status` 为 `closed`、`half_day` 或 `unknown`；`closed` 匹配全天休市（`holiday` 或 `weekend`），不改变 API 日期状态。不提供时显示该市场全部日期。再次点击当前状态取消筛选。刷新直接读取 URL，不先显示另一市场。年月合并为 `month=YYYY-MM`，选中日期只记 `day=24`；默认状态省略。旧 calYear/calMonth/calDay/calStatus 地址继续读取，下一次操作转换为精简形式。Web 的 `market=ALL` 仅表示前端三地汇总，单市场 API 不接受 ALL；全部视图使用批量端点或分别请求 US/HK/CN 后汇总。


## 个人资源库

冻结合约 1 与字段、分页/排序、类型、限额、结果查询、私有下载、永久删除回执见 [App 个人资源库](app-resource-library.md)。`resource_library` discovery 出现后才启用；resources.write 必须包含 resources.read，基础登录范围保持原样。


## 分步账户验证与邮件模板

邮件六位验证码30分钟有效，验证后修改凭证5分钟一次性有效，成功撤销全部登录与App授权。完整请求与发现字段见 `docs/native-account-change-contract.md`。

| 方法 | 路径 | 授权 |
| --- | --- | --- |
| GET | `/api/v2/auth/mail-templates` | public |
| POST | `/api/v2/auth/password-change/verify` | security.write |
| POST | `/api/v2/auth/password-change/confirm` | security.write |
| POST | `/api/v2/auth/email-change/request` | security.write |
| POST | `/api/v2/auth/email-change/verify` | security.write |
| POST | `/api/v2/auth/email-change/confirm` | security.write |


## 全球预览资产配置

Web入口 `/global?section=allocation`，Web接口 `/api/asset-allocation`；App由 `auth/config.asset_allocation` 发现选定版本路径。

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v2/asset-allocation` | portfolio.read |
| POST | `/api/v2/asset-allocation` | portfolio.write |
| PUT | `/api/v2/asset-allocation` | portfolio.write |
| DELETE | `/api/v2/asset-allocation` | portfolio.write |
| POST | `/api/v2/asset-allocation/assign` | portfolio.write |

GET可选 `?currency=USD`（服务端汇率支持的三字币种），200返回标准信封。`data`含 `version:1`、`accountId`、`currency`、`observedAt`、`snapshotRevision`、`summary`、`accounts`、`bankSummary`、`categories`、`issues`、`quoteStatus`。所有估值与汇总统一使用显示币种；账户 `amount` / `holdings` / `cash` 使用该账户原币 `currency`。

GET返回弱 `ETag: W/"{snapshotRevision}"`；同账号同币种携带 `If-None-Match`，未变化返回304空正文，必须复用匹配的内存快照，不调用JSON解析。200/304均重新检查认证与当前来源，返回 `X-Allocation-Observed-At`（本次核算时间，非行情时间）、`Cache-Control: no-store, private` 与 `Vary: Authorization, Cookie, X-Allocation-User`。snapshotRevision排除observedAt，其余快照内容参与指纹；不能代替写入revision。401/403/账号冲突应清空旧快照。切换币种后新换算到达前保持旧快照币种与金额一致。

能力发现声明 `conditional_read=weak-etag`、`snapshot_revision_field=snapshotRevision`、`checked_at_header=X-Allocation-Observed-At`，建议读取8秒、写入12秒总超时（含正文），前台每30秒补读、隐藏停止；失败退避、不自动重放写入，超时或409先读取核对。`source_connection=local-ledgers`、`external_institution_connections=false` 表示关联本站来源，未直连外部银行/券商。

- `summary`: totalAsset、totalDebt、netAsset、knownAsset、complete、accountCount、portfolioTotalAsset、difference。未转换或现金重复候选时总额为null，不以已知部分冒充完整总额；knownAsset仅作已知部分诊断。
- `accounts`: id、name、kind（broker/bank/fund/ledger/manual）、category、currency、amount、value、holdings、cash、recordIds、source、updatedAt、excluded、reconciled、revision、components。components按证券/现金等分类使用显示币种；包含现金的券商总权益不重复叠加证券。原持仓记录价回退由quoteStatus.missing声明。
- `categories`: id、name、value、weightPct；负债与总额不完整时不提供资产占比。
- `bankSummary`: count、includedCount、value，分别为非零余额银行卡总数、计入数量及显示币种合计。银行卡未录或零余额时不出现在accounts及汇总；非零金额的缺汇率/损坏来源仍报异常。value先汇总后取两位小数，缺估值为null；银行卡明细由accounts.kind=bank读取。与Web收拢节点同源。
- `issues`: code、accountIds、message。cash_overlap需要核对待归属资金与券商总权益是否重复；source_removed仅保留核对记录、不再计入。

POST新增账户：`{requestId:"11111111-1111-4111-8111-111111111111",revision:0,name:"储蓄账户",currency:"CNY",amount:10000,category:"cash",excluded:false}`。类别为securities/cash/investment/fixed/receivable/debt；负债填正数，现金允许融资负余额。新增requestId须为固定的小写UUID，同一请求重复提交返回409且不会新增第二个账户；超时后读取`manual:{requestId}`核对结果。PUT核对已有来源或手动账户：去除requestId，同字段加本人 `id` 与读取的 `revision`；关联来源币种/类别不可更改，券商amount为含现金总权益。返回 `{id,revision}`。DELETE：`{id,revision}`，删除手动账户或恢复关联来源，返回 `{id,restored}`。40902表示版本变化，40401表示非本人/不存在的来源。

关联账户 PUT 支持 `amountMode:"automatic"|"statement"`，省略时按原合同保存人工核对金额。只改名称或计入状态且未修改金额时，Web 发送 `automatic`，仅保存名称和计入状态，金额继续跟随原来源；手动账户禁止 automatic。已核对账户的金额保持 statement，恢复自动关联会保留自定义名称、恢复计入并继续跟随来源。App发现通过 `linked_amount_mode_field`、`linked_amount_modes`、`default_amount_mode` 与 `restore_preserves_name` 声明该行为。

配置存服务器，Web与两版App共用。可传 `X-Allocation-User: accountId` 防止切换账号后旧表单保存；写入不自动重试。核对值是人工账单快照，恢复自动关联后再跟随原来源。v2只接受App Bearer。完整来源、范围、MIT路由参考及核算语义见 [资产配置说明](asset-allocation.md)。

`data.brokers`为已有券商的{id,name,icon}；`data.positions`包含持仓的{id,name,code,currency,brokerId,revision,accountId}。POST asset-allocation/assign：`{brokerId,records:[{id,revision}]}`，每批最多200项，整批验证本人持仓/版本后同步真实记录的券商归属；不改变数量、成本、报价或成交。相关券商存在人工权益核对值时先恢复自动关联，避免分配后保留过时账单总额。
