# iOS 账户安全 v1 合约 · 2026-10-01

状态：合约冻结，服务端已实现并完成本地回归，代码通过 main 同步，镜像发布与部署另行进行。不得把线上缺失字段当可用。所有响应为 {code,message,data}，时间为 Unix 毫秒，写请求不自动重放。

App v2 接入见 [迁移合约](app-api-v2.md)：安全 payload、错误码和能力沿用本文件，路径前缀及 security.version 改为 v2；保留 v1 供旧连接使用。

## 授权和发现

auth/config 保留默认 scope，scopes_supported 新增 security.read、security.write（write 必须同时申请 read）。授权页明确显示查看/管理账户安全。旧 grant 不扩权。所有下列私有接口严格仅接受 PKCE App Bearer，不接受 Cookie 或 Web session token。auth/me 保留直接 User。

config.security = {version:1,read_scope:"security.read",write_scope:"security.write",email_verification_path:"/api/v1/auth/email-verification",totp_path:"/api/v1/auth/totp",passkeys_path:"/api/v1/auth/passkeys",devices_path:"/api/v1/auth/security-devices",password_reset_path:"/api/v1/auth/password-reset",passkey_registration:{supported:false,rpID,origin,reason:"associated_domain_unverified"}}。

User.capabilities 新增 emailVerification、twoFactorRead、twoFactorWrite、passkeysRead、passkeysWrite、passkeyRegistration、devicesRead、devicesWrite、passwordRecovery。read 字段由 security.read 决定，write 由 security.write 决定，emailVerification 另需邮件与链接域名配置，passwordRecovery 表示公共恢复API支持（不保证某账号能收到邮件）。passkeyRegistration 默认 false，目前仓库没有已验证关联域名/签名/AASA。User.security 保留 twoFactorEnabled。

## 私有端点（相对于 /api/v1/auth）

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

## 公共密码恢复（无需 Bearer，登录内外均可使用）

- POST password-reset/request {login,challenge?} → {ok:true,challenge,retryAfter:60,message}，对未知账号、未验证邮箱、邮件服务不可用等使用一致回执与随机 challenge。仅已验证邮箱实际异步发送验证码，限流与共享邮件预算沿用 Web。challenge 不放 URL。
- POST password-reset/verify {challenge,code} → {ok:true,token,expiresAt}，错误统一40003，不泄露账号；最多5次，5分钟期限，一次性消费验证码。
- POST password-reset/confirm {token,newPassword} → {ok:true,reauthenticationRequired:true}，一次性恢复凭证与改密/撤销全部会话同事务。成功仅清除发起恢复时仍匹配的本地连接。弱密码不消费 token。token 不放 URL，不记录日志/缓存。

## Passkey 部署前提

Apple 要求 App 的 Associated Domains entitlement 中包含 webcredentials:RP域名；对应公开 HTTPS 域名在 /.well-known/apple-app-site-association 提供 webcredentials.apps 的实际 TeamID.BundleID。已检查 iOS 的 Alcor.entitlements / Alcor-Simulator.entitlements，缺少 Associated Domains；只读请求默认域名的443和18520端口 AASA 均未成功读取，不能确认部署具备关联关系。不能仅因 Web passkey.enabled=true 宣称原生注册可用。本轮不改签名、不部署 AASA、不放宽 challenge/origin/RP/user verification。
参考：[Apple passkeys](https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys)、[Associated Domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)。

## 服务端交付验证

- npx tsc --noEmit、生产构建、git diff --check 通过。
- npm run test:review 完整回归通过；安全专项 tests/app-native-security.cjs 最终12组通过，均使用临时SQLite与模拟网络/邮件。
- 公开仓库与部署一致性审计通过。原生注册保持503，不调用生产邮件/安全写接口。
- 3000端口由其他本地实例占用，未停止该实例、未更换端口；没有对本分支运行真实HTTP smoke-test。路由已编译，处理器回归使用 Request/NextResponse。
- 实现与回归使用隔离工作树；同步 main 时保留其他网页工作未提交改动，不提交其文件。本轮仅推送代码，未触发手动镜像发布；部署后的端到端验收仍需以实际服务能力为准。
