# App 跨设备授权 · 2026-10-25

根因：原生登录固定发出 portfolio.read/portfolio.write。iOS 412 的同本人偏好只在本机，另一设备既看不到选择，也拿不到相应令牌。此修复不复制手机令牌或直接改变勾选。

native_login.account_consent 明确声明 version=1、固定 /api/v2/auth/consent、current_grant、account_client。旧客户端/服务保持原协议；新客户端不把本地选择写到恢复接口。

GET 使用当前设备有效 App Bearer，返回 apiVersion=2/version=1/client_id/user_id/grant_id/scope/revision。响应 private,no-store；Cookie 不可替代。scope 是账户对该客户端的批准，不等于当前设备已有权限。

POST 只收 client_id/revision。事务中重新验证当前令牌、本人和最新 revision（不一致 409），只把当前 grant 与已批准范围合并签发本设备新 grant，返回原生 permissions 完整回执及 replaces_grant_id。调用方只在身份、精确范围、替换关系、来源及 CAS 均有效后存新令牌并撤销自己的旧令牌；不撤销其他设备。

账户批准以 user_id/client_id 主键持久化，显式 permissions 和成功 PKCE 交换更新；普通登录、恢复、退出不扩大或擦除它。旧安装没有记录时，选择同客户端最近仍有效的扩展 grant，不合并各设备，不接受撤销/过期/安全凭据失效者。初次原生登录签发前迁入，避免设备上限删除唯一旧证据。没有可靠证据仍需一次明确授权。

账号级撤销原子撤销 token 家族并保存基础范围，密码/因子改变不复活旧批准。仅因 legacy TOTP 秘钥加密格式迁移时，跟随现有验证保持安全戳，仍保留撤销状态。删除单设备表示撤销该设备连接，重新验证账户登录后可恢复账户批准，不等于撤回整个 App 的批准。

测试：tests/app-account-consent.cjs（隔离数据库与网络）和原有 native-login/auth/security/v2 回归。iOS 414 验证新登录恢复、已登录页面恢复及无批准、冲突、离线、错误身份/权限/替换关系。

上线依赖：服务端与 iOS 均须更新。源码提交、隔离测试和模拟器不等于已发布服务或真实双设备验收。按 AGENTS.md 手动发布约定执行，不自动部署、不使用本人凭据进行测试。
