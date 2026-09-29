# Fire App 连接与 API 审查

日期：2026-09-30。Web 与 iOS 独立维护，只共享公开 HTTP 合同。

## 服务器与域名

App 设置内的连接页首次预填 `https://fire.6dm.tv:18520`，允许更换。点击连接立即用 ASWebAuthenticationSession 打开所选源的 `/app/authorize`，不因预检失败阻止浏览器弹出；`GET /api/v1/auth/config` 保留供协议能力查询。授权及令牌路径遵循固定 v1 合同，不接受第三方指定任意换令牌服务器。App 首屏直接进入本地应用，授权是设置中的可选操作。

生产部署设置正确的公网 HTTPS 域名（含非默认端口），或设置 `FIRE_APP_ORIGIN`；授权、换令牌和撤销只接受该源。开发环境允许 localhost / 127.0.0.1 HTTP。App Release 只接受 HTTPS，Debug 额外接受回环 HTTP。

域名迁移后，更新部署设置，在 App「更换服务器」重新连接。API 不自动跟随 3xx，凭据、缓存和用户身份均绑定所选源。旧域名跳转到新域名不能自动转交令牌。每个自部署安装配置自己的域名，无需重编 App。

## 已审查与修复

- records 原 API 已有统一信封、分页和用户隔离，App 却只读第 1 页 100 条：改为读取分页 meta 并加载全部页，失败不交付部分列表。offset 分页在同时修改数据时仍可能变化，刷新可重新读取；本次没有引入离线账本同步。
- 公共素材接口已有分页，App 图标库原来已遍历分页，保持既有行为。
- 券商是全站目录，维护接口要求管理员；App 收起增删和排序入口，只读取目录。个人持仓的券商归属仍由 records 管理。不把站点维护权限授予 App。
- 移除 App 未使用的旧 `/api/settings` 读写方法；本次业务请求统一走 `/api/v1`。
- API 信封增加 no-store/private，分页参数只接受有界有限整数，避免 Infinity / 小数产生不完整列表。
- Web 的 Cookie 活跃续期不能解决原 App Bearer 固定 7 天失效：新增独立设备授权和短时访问/轮换刷新令牌，不修改旧客户端登录合同。
- 备份下载、Excel 导出、portfolio-series 等部分 v1 接口仍有文件/裸响应合同；App 本次不消费这些裸 JSON 接口，不全站改格式，避免影响既有 Web 调用方。
- overview 已经由服务端统一币种、报价回退与完整性计算，本次不改变资产/收益口径；iOS 历史走势仍沿用既有真实行情回溯规则。

## 授权合同

这是第一方 App 的授权码 + PKCE S256 流程；v1 JSON 请求/响应遵循 Fire 信封，不是第三方通用 OIDC 身份提供商。

| 项目 | 值 |
| --- | --- |
| client_id | fire-ios（公开客户端，安装包中无 client_secret） |
| response_type | code |
| redirect_uri | com.fire.app:/oauth/callback（精确匹配） |
| scope | portfolio.read portfolio.write；可以申请仅 portfolio.read |
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

令牌响应位于 data：`{ access_token, refresh_token, token_type, expires_in, grant_id, scope }`。token 接口支持 Fire JSON 和受大小限制的 form-urlencoded 输入；所有响应不缓存。

## 设备、权限与撤销

- `GET /api/v1/auth/devices`、`DELETE /api/v1/auth/devices`（body `{ id }`）仅浏览器本人 Cookie 会话可用；删除需同源 Origin，跨账户 ID 不影响他人。
- 网页「设置 → 个人信息」提供「已连接设备」入口，页面 `/app/devices`。App 设置也可打开该页面。
- App POST `/api/v1/auth/revoke`（`{ client_id, token: refresh_token }`）撤销当前授权，访问/刷新令牌同时失效；浏览器会话独立。
- 改密/重置密码或 TOTP 开关/密钥变化立即使 App 凭据失效；deleteOtherSessions 同时撤销 App grants 与未兑换 codes；删除作为登录来源的 passkey 也立即失效。删除用户使用 FK 级联清除凭据。
- 每用户最多保留 20 个 App 授权。数据库只存 token/code 摘要、账号认证状态摘要，不保存明文凭据。
- App 请求限制为 `/api/v1` 个人资源与公开行情；服务器强制 scope。管理员通过 App 返回个人业务身份，不能操作站点设置、素材维护、券商目录维护或账号安全配置。

## iOS 状态与缓存

一份 Keychain item 原子保存源、grant ID、access/refresh、到期时间与本人资料。actor 合并并发刷新；刷新与登出/连接变更竞争时，旧响应不能覆盖当前凭据。断网/超时不登出，确切刷新 401 才清除连接。

私人读缓存按源 + grant + 请求路径隔离，受 iOS 文件保护，24 小时过期，只在网络不可达/超时恢复。缓存不伪装成在线成功：显示离线及缓存时间。后台刷新成功清除离线状态。401/403/5xx/取消任务不使用缓存掩盖问题。断开/新连接清除私人缓存；公开行情缓存区分数据来源，演示行情与真实行情隔离。

离线不排队写入交易或资金，不自动重放网络失败的写请求。离线断开立即删除本机凭据；服务端撤销需要联网，如撤销请求无法送达，可从 Web 的设备页撤销。本地账本、iCloud 文件备份与演示数据属于 App 独立能力，不同步到 Web。设置内可开启演示数据，关闭回到原数据来源；演示数据不进入个人备份。

第一次升级需重新网页授权，旧 UserDefaults Bearer 不迁移为长期设备授权。

## 验证

`node tests/app-auth.cjs` 使用临时数据库覆盖 PKCE / 回调 / state、同源同意、代码重放与过期、访问/刷新有效期、令牌重放、并发刷新、账户隔离、100+ 持仓分页、scope / 管理权限、设备撤销、改密和 TOTP 变更、FK 级联及数据库凭据摘要；加入 test:review。iOS 构建和模拟器测试单独记录在其版本日志。
