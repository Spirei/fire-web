# Alcor App 连接与 API 审查

日期：2026-10-01。Web 与 iOS 独立维护，只共享公开 HTTP 合同。

## 服务器与域名

App 设置内的连接页首次预填 `https://fire.6dm.tv:18520`，允许更换。点击连接立即用 ASWebAuthenticationSession 打开所选源的 `/app/authorize`，不因预检失败阻止浏览器弹出；`GET /api/v1/auth/config` 保留供协议能力查询。授权及令牌路径遵循固定 v1 合同，不接受第三方指定任意换令牌服务器。App 首屏直接进入本地应用，授权是设置中的可选操作。

生产部署设置正确的公网 HTTPS 域名（含非默认端口），或设置 `FIRE_APP_ORIGIN`；授权、换令牌、撤销及 App 业务令牌请求只接受该源。HTTPS 反向代理保留原 Host，并传递 `x-forwarded-proto: https`。开发环境允许 localhost / 127.0.0.1 HTTP。App Release 只接受 HTTPS，Debug 额外接受回环 HTTP。

域名迁移后，更新部署设置，在 App「更换服务器」重新连接。API 不自动跟随 3xx，凭据、缓存和用户身份均绑定所选源。旧域名跳转到新域名不能自动转交令牌。每个自部署安装配置自己的域名，无需重编 App。

## 已审查与修复

- records 原 API 已有统一信封、分页和用户隔离，App 却只读第 1 页 100 条：改为读取分页 meta 并加载全部页，失败不交付部分列表。offset 分页在同时修改数据时仍可能变化，刷新可重新读取；本次没有引入离线账本同步。
- 公共素材接口已有分页，App 图标库原来已遍历分页，保持既有行为。
- 券商是全站目录，维护接口要求管理员；App 收起增删和排序入口，只读取目录。个人持仓的券商归属仍由 records 管理。不把站点维护权限授予 App。
- 移除 App 未使用的旧 `/api/settings` 读写方法；本次业务请求统一走 `/api/v1`。
- API 信封增加 no-store/private，分页参数只接受有界有限整数，避免 Infinity / 小数产生不完整列表。
- Web 的 Cookie 活跃续期不能解决原 App Bearer 固定 7 天失效：新增独立设备授权和短时访问/轮换刷新令牌，不修改旧客户端登录合同。
- 备份下载、Excel 导出、portfolio-series 等部分 v1 接口仍有文件/裸响应合同；App 本次不消费这些裸 JSON 接口，不全站改格式，避免影响既有 Web 调用方。
- overview 增加含现金的总资产，Web 与 App 共用价格、汇率及账户现金核算；保留证券汇总和历史走势的含义，不把持仓市值冒充总资产，不虚构历史现金。

## 授权合同

这是第一方 App 的授权码 + PKCE S256 流程；v1 JSON 请求/响应遵循 Alcor 信封，不是第三方通用 OIDC 身份提供商。

| 项目 | 值 |
| --- | --- |
| client_id | fire-ios（公开客户端，安装包中无 client_secret） |
| response_type | code |
| redirect_uri | com.fire.app:/oauth/callback（精确匹配） |
| scope | 默认 portfolio.read portfolio.write；可仅 portfolio.read；资料编辑另明确申请 profile.write |
| code_challenge_method | S256 |
| state | 32–128 位 URL-safe 随机字符串，App 校验精确匹配 |
| authorization code | 随机、不透明、一次性，60 秒有效 |
| access token | 随机不透明，15 分钟有效，Bearer 请求 |
| refresh token | 每次成功刷新轮换，30 天无刷新失效，授权绝对最长 90 天 |

1. App 生成 verifier / state，使用 ASWebAuthenticationSession 立即打开所选源的 `/app/authorize`。
2. Web 验证客户端、固定回调、scope / state / challenge。未登录时保留授权请求，进入既有 Web 登录；通行密钥和 TOTP 不另造一套。
3. 用户确认账户与权限，浏览器 POST `/api/v1/auth/authorize`。必须带同源 Origin、真实 Cookie 会话，拒绝 Bearer 发起同意。GET 不创建授权码。
4. 回调只携带 code + state（取消携带 access_denied），不携带访问/刷新令牌。
5. App POST `/api/v1/auth/token`，提交 grant_type=authorization_code、client_id、redirect_uri、code、code_verifier。服务端事务内校验并消费；源浏览器会话退出/过期后不能兑换。
6. grant_type=refresh_token 携带 client_id / refresh_token，在 IMMEDIATE 事务内轮换。旧刷新令牌重放撤销整个设备授权，包括仍未到期的 access token。

令牌响应位于 data：`{ access_token, refresh_token, token_type, expires_in, grant_id, scope }`。token 接口支持 Alcor JSON 和受大小限制的 form-urlencoded 输入；所有响应不缓存。

## 设备、权限与撤销

- `GET /api/v1/auth/devices`、`DELETE /api/v1/auth/devices`（body `{ id }`）仅浏览器本人 Cookie 会话可用；删除需同源 Origin，跨账户 ID 不影响他人。
- 网页「设置 → 账号与安全 → 应用授权」集中显示连接配置、连接测试和本人已连接设备。管理员可填写站点共用的 HTTPS 地址、App 显示名称与图标，经既有 `/api/settings` 保存；普通用户只读配置并管理自己的授权。断开使用独立确认弹窗，访问和刷新令牌同时失效，不退出 Web 或删除投资记录。旧页面 `/app/devices` 仍可查看与断开设备，未登录时登录后返回此页面。
- 连接测试只读取当前站点 `/api/v1/auth/config`、`/api/v1/auth/me` 与 `/api/v1/auth/devices`，校验固定 PKCE 协议、当前身份和本人设备读取；10 秒超时、禁止跳转，不读取或显示令牌。不请求管理员输入的地址，避免把当前 Cookie 或授权转发给其他服务器；当前访问源与配置地址不同时，明确提示测试不能代表配置域名的外网可达性。`FIRE_APP_ORIGIN` 仍优先于站点域名。
- 授权页站点名称与标识复用 `logoText` / `siteLogo` / `ico`；「应用授权 → 连接配置」配置 `appDisplayName`（空值跟随站点名称）与 `appDisplayIcon`（空值使用 PWA 图标或内置默认）。图片支持上传、站内路径及 http(s) 地址；外部图标不发送 Referer，文件清理保护正在使用的图标。显示配置不改变 `client_id`、固定回调或权限边界；网站形象的保存与重置不再覆盖这两项。
- App POST `/api/v1/auth/revoke`（`{ client_id, token: refresh_token }`）撤销当前授权，访问/刷新令牌同时失效；浏览器会话独立。
- 改密/重置密码或 TOTP 开关/密钥变化立即使 App 凭据失效；deleteOtherSessions 同时撤销 App grants 与未兑换 codes；删除作为登录来源的 passkey 也立即失效。删除用户使用 FK 级联清除凭据。
- 每用户最多保留 20 个 App 授权。数据库只存 token/code 摘要、账号认证状态摘要，不保存明文凭据。
- App 请求限制为 `/api/v1` 个人资源与公开行情；服务器强制 scope。管理员通过 App 返回个人业务身份，不能操作站点设置、素材维护、券商目录维护或账号安全配置。

本人身份通过 `GET /api/v1/auth/me` 读取既有 `users`，不创建独立 App 账号。通用资料和头像编辑仍需显式 `profile.write`，旧 grant 的 scope 及刷新不扩权。邮箱与密码使用下述专用本人自助接口，任何有效的本人连接均可在验证账号凭据后操作，不要求管理员或投资写权限。TOTP、通行密钥及设备撤销仍由网站安全设置管理。

### 本人资料与头像

- `GET /api/v1/auth/me` 和 `PUT /api/v1/auth/profile` 的 `data` 都是直接 User，不嵌套 `user`；新增 `scope` 与 `capabilities: { profileWrite, avatarUpload, emailWrite, passwordWrite, overviewTotalAssets }`，以及 `security: { twoFactorEnabled }`。App 角色始终为 `user`；Cookie/旧网站会话的 `scope` 为空。只返回本人安全能力，不返回密码摘要、TOTP 密钥或备份码。
- `PUT /api/v1/auth/profile` 仅部分更新 `username`、`nickname`、`email`；未提交字段保留最新值。Web 与 App 共用校验及冲突检查，禁止修改 ID、UID、角色、密码或任意头像地址。邮箱实际改变需 `currentPassword`，v1 已开启 TOTP 时还需 `code`，与专用邮箱入口一致；验证状态与恢复凭据按网站原规则失效，不自动验证新邮箱。
- `POST /api/v1/upload` 使用 multipart `kind=avatar`、`file`，返回 `data: { url, kind }`。App 只可上传本人的 JPG/PNG/GIF/WEBP 头像，5 MiB 上限，拒绝 SVG/伪格式及共享素材上传；命名继续用 `username(UID编号)`。Web/读取本人资料立即看到同一头像。
- 缺少编辑授权返回 401 / `40101`（不从 Cookie 补权），邮箱密码验证失败 403 / `40301`，用户名/邮箱冲突 409 / `40901`，参数错误 400 / `40001`，限流 429 / `42901`。保存失败不返回数据库内部错误。
- 异步读取请求体/图片后在写锁内再次认证，撤销/改密与并发资料更新不能绕过检查；图片原子替换，数据库写入失败恢复旧图片，未保存文件不留在上传目录。

### 本人邮箱与密码自助

连接发现新增 `email_path` 和 `password_path`；App 必须先发现能力，旧服务器没有相应端点/能力时不得宣称修改成功。普通账号、站点管理员的 App 个人身份、默认或 `portfolio.read` 只读连接均适用；令牌仍只能操作自己的账号，拒绝 ID/UID/角色/其他安全字段，不能用浏览器 Cookie 替无效 Bearer 补权。

- `PUT /api/v1/auth/email`：JSON `{ "email": "new@example.com", "currentPassword": "当前密码", "code": "可选二次验证码或一次性备用码" }`；邮箱可为空以解绑。即便邮箱未变，也须验证当前密码；已开启 TOTP 时 code 必填（失败 HTTP403/code40301），通用 v1 profile 改邮箱也不能绕过。共用 Web 格式、大小写无关冲突检查、事务保存及邮箱验证/恢复凭据失效规则；不自动验证新邮箱。成功 `data` 是直接 User + scope/capabilities/security，Web 与后续 me 立即读取同一行。错密码 HTTP 403 / `40301`，冲突 409 / `40901`。
- `POST /api/v1/auth/password`：JSON `{ "currentPassword": "当前密码", "newPassword": "新密码", "code": "可选二次验证码或一次性备用码" }`。密码与 Web 共用 8–128 位、同时含字母和数字的规则；已开启 TOTP 时 code 必填，不允许绕过。错误密码 HTTP 403 / `40103`，二次验证失败 HTTP 403 / `40104`；这些错误不等于连接过期，不应清空连接。
- 改密成功 `data: { ok: true, signedOutOthers: true, reauthenticationRequired: true, user: User }`。在同一事务内更新密码、消费成功因子、撤销本人全部 Web 会话、App 授权及未兑换授权码；所有旧访问/刷新令牌失效，旧恢复凭据不能使用。只回传公开身份，不生成或返回新令牌，不自动扩权。App 在收到明确成功后清除旧凭据并提示重新登录/网页授权；若请求超时结果不确定，先提示重新登录确认，不自动重试改密或把失败说成成功。
- 邮箱/密码修改均在异步请求读取后重新认证，16 KiB JSON 上限；不接受任意额外身份字段。参数错误 400 / `40001`、连接失效 401 / `40101`、限流 429 / `42901`、存储失败 500 / `50001`，错误不包含内部诊断。密码、TOTP、备份码不进入审计日志；仅记录行为和结果。
- 资料/邮箱共用每账号及来源 30 次/小时、全站 300 次/小时限制；密码共用 Web/App 每账号及来源 20 次/15 分钟、全站 100 次/15 分钟限制，换 IP 不绕过账号配额。保存或会话撤销失败完整回滚，包括已验证的一次性因子；他人账号、会话与投资数据不受影响。旧 Web 改密仍使用 oldPassword/newPassword/signOutOthers/code，保留当前 Web 会话与可选退出其他 Web 会话的既有行为；App 凭据始终失效。

### 规范总资产

`GET /api/v1/overview?currency=USD` 返回原有证券字段，以及 `totalAsset`、`totalCash`、`totalAssetComplete`、`cashComplete`、`unconvertedCurrencies`。金额同响应 `currency`，默认 USD；新金额可能为 `null`，不得当作 0。

- `totalAsset = 当前持仓市值 + 核算现金`。现金含有符号资金流水、已成交订单现金、借记卡/预付卡余额一次，不含信用额度；挂单预留现金不从总资产扣除。历史订单只读派生，不为读取 overview 修补真实流水。
- 简化账本按 Web 原有规则选同市场最大正资产的主账户，仅已导入的 US/HK/CN/JP/KR 且结算币种一致时，使用 `账户权益 − 本币持仓 + 银行卡现金` 覆盖该币种余额，不叠加其他未导入券商。报价变化会同时改变反推现金，App 不能把旧现金加到新市值。
- Web `AssetAnalysisDashboard` 与 API 共用 `lib/accountCash.ts`，资金出口共用只读订单余额；页面布局不变。FX 缺失不按 1:1；缺失来源/损坏账本使新金额为 null。`complete/unconverted` 保持证券 FX 语义；`cashComplete` 仅现金，`totalAssetComplete` 综合检查。`unconvertedCurrencies` 含缺失现金/持仓币种，无法识别卡元数据标记 `UNKNOWN`，未知市场为 `UNKNOWN:市场`。
- 响应 `no-store, private`，最新持仓/现金在报价 I/O 后同一只读快照汇总；标的改动丢弃旧标的报价。使用网站同一汇率表（含已有明确兜底，不是 1:1）；价格缺失使用记录价格，空记录价格与 Web 一致按 0。
- 建议 App 前台每 30 秒、回到首页/前台以及下拉时刷新 overview，休市也同步现金；直接显示服务端 totalAsset。历史图没有现金快照时继续标明「持仓市值」，不拼造历史总资产。

## 2026-10-01 第二轮安全审查

- 修复已复现的凭据失效遗漏：改密并保留其他网页登录时，旧的未兑换授权码原本仍可签发新 App 令牌。现在密码更新与 App 授权撤销／授权码删除使用同一写事务；双重验证启用和关闭同步清理。写入失败整体回滚，保留网页登录不等于保留旧 App 凭据。无需数据库迁移，也不批量撤销正常授权。
- `/api/settings` 不再只依赖浏览器验证连接地址：更改域名必须是无凭据、无路径／参数的公网 HTTPS 源，开发环境另允许回环 HTTP；非对象请求体被拒绝。未修改的旧局域网域名可随其他配置保存，留空仍保留环境变量配置方式，不自动覆盖已上线地址。
- 浏览器授权结果只接受固定 `com.fire.app:/oauth/callback`、原请求 state，以及 code 或 access_denied 之一；拒绝其他协议、跳转地址、重复参数、令牌参数和片段。图标预览先校验 URL 再加载，保持无 Referer 和默认图兜底。
- 连接测试和设备读取限制 64 KiB JSON，并校验响应结构；授权／断开／上传回执限制 8 KiB，配置回执限制 1 MiB。请求均不接受重定向，诊断不直接显示上游任意文本。设备读取 12 秒、保存／授权／断开 15 秒超时；保存结果不确定时要求刷新核对，断开不虚报成功、不提前移除设备，并重新读取列表。退出页面中止在途操作，不自动重放写入。
- 仅更新已有依赖补丁：undici 8.10.2、brace-expansion 1.1.21 与 2.1.7。更新后 `npm audit` 无已知漏洞，不代表没有未知漏洞。代理验收使用本机 HTTP CONNECT 假服务，不连接外网、不读取应用数据库；Excel 导入继续由既有隔离回归覆盖。

## iOS 状态与缓存

一份 Keychain item 原子保存源、grant ID、access/refresh、到期时间与本人资料。actor 合并并发刷新；刷新与登出/连接变更竞争时，旧响应不能覆盖当前凭据。断网/超时不登出，确切刷新 401 才清除连接。

私人读缓存按源 + grant + 请求路径隔离，受 iOS 文件保护，24 小时过期，只在网络不可达/超时恢复。缓存不伪装成在线成功：显示离线及缓存时间。后台刷新成功清除离线状态。401/403/5xx/取消任务不使用缓存掩盖问题。断开/新连接清除私人缓存；公开行情缓存区分数据来源，演示行情与真实行情隔离。

离线不排队写入交易或资金，不自动重放网络失败的写请求。离线断开立即删除本机凭据；服务端撤销需要联网，如撤销请求无法送达，可从 Web 的设备页撤销。本地账本、iCloud 文件备份与演示数据属于 App 独立能力，不同步到 Web。设置内可开启演示数据，关闭回到原数据来源；演示数据不进入个人备份。

第一次升级需重新网页授权，旧 UserDefaults Bearer 不迁移为长期设备授权。

## 验证

`node tests/app-auth.cjs` 使用临时数据库覆盖 PKCE / 回调 / state、同源同意、代码重放与过期、访问/刷新有效期、令牌重放、并发刷新、账户隔离、100+ 持仓分页、scope / 管理权限、设备撤销、改密和 TOTP 变更、FK 级联及凭据摘要。`tests/app-profile.cjs`、`tests/app-account-security.cjs` 和 `tests/account-overview.cjs` 验证双向资料同步、本人邮箱/密码自助、凭据原子失效、二次验证及失败回滚、跨 IP 限流、头像安全、现金同源/去重/负余额、主账户权益覆盖、缺 FX/源异常、读接口不补写账本、分页外持仓和异步快照；全部加入 test:review，不改真实账号或资金。iOS 构建和模拟器测试单独记录在其版本日志。
