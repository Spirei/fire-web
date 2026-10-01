# App 原生登录 · v2

状态：服务端已实现并完成临时库回归；以服务端实际 `auth/config` 能力为可用依据，代码提交不等于已部署。

## 发现与版本

匿名 `/api/v1/auth/config` 与 `/api/v2/auth/config` 新增 `native_login`：

```json
{
  "supported": true,
  "version": 1,
  "api_version": 2,
  "client_id": "fire-ios",
  "login_path": "/api/v2/auth/login",
  "two_factor_path": "/api/v2/auth/login/totp",
  "permissions_path": "/api/v2/auth/permissions",
  "scope": "portfolio.read portfolio.write",
  "scopes_supported": ["portfolio.read", "portfolio.write", "profile.write", "feed.read", "feed.write", "security.read", "security.write"],
  "factors": ["totp", "backup_code"],
  "challenge_expires_in": 300
}
```

`version` 是原生登录合约结构版本；`api_version` 固定 2。所有端点必须校验为以上固定同源路径；旧服务没有能力、声明不完整或 v2 发现失败时不猜端点、不降级到 v1 长期 Web token 登录。现有 PKCE 连接仍可使用原流程。

## 基础登录

`POST /api/v2/auth/login`，匿名 JSON，无 Cookie：

```json
{"client_id":"fire-ios","username":"用户名或邮箱","password":"密码","device_name":"我的 iPhone"}
```

`device_name` 可省略。`username` 支持用户名或邮箱，沿用现有用户库与密码校验。请求不接受 `scope`、`userId` 等字段；基础 scope 固定 `portfolio.read portfolio.write`，不自动加入资料、动态或安全管理权限。

无二步验证，HTTP 200：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "status": "authenticated",
    "apiVersion": 2,
    "access_token": "fat_...",
    "refresh_token": "frt_...",
    "token_type": "Bearer",
    "expires_in": 900,
    "grant_id": "fg_...",
    "scope": "portfolio.read portfolio.write",
    "user": {"id":"u-...","username":"...","nickname":"...","uid":"...","email":"...","emailVerified":false,"avatar":"...","role":"user","isTest":false,"scope":"portfolio.read portfolio.write","capabilities":{},"security":{"twoFactorEnabled":false}}
  }
}
```

`user` 与该令牌调用 `GET /api/v2/auth/me` 的响应完全一致，包含真实头像与完整 capabilities。即使网站账户为管理员，App 的 `role` 仍为 `user`，不获得后台管理权限。显示头像只需有效基础登录，不依赖 `profile.write`。

## 二步验证

启用 TOTP 时，密码正确后 HTTP 200，不发 User 或任何会话令牌：

```json
{"code":0,"message":"ok","data":{"status":"requires_2fa","apiVersion":2,"purpose":"login","challenge_token":"flc_...","expires_in":300,"factors":["totp","backup_code"]}}
```

`POST /api/v2/auth/login/totp`：

```json
{"client_id":"fire-ios","challenge_token":"flc_...","code":"验证码或备用码"}
```

成功返回同一 `authenticated` 结构。验证码与备用码沿用网站的单次消费和重放保护。挑战仅保存摘要，绑定账户安全状态、client、origin、scope 与用途；5 分钟过期，最多 8 次验证尝试，成功只可消费一次。更改密码或二步设置后旧挑战失效。Web 的 ticket 不能交给此端点，原生挑战也不能用于 v1/Web 登录。

## 明确申请额外权限

基础登录不走网页 OAuth 同意。用户明确执行修改头像/资料、账户安全或动态操作后，客户端展示将申请的权限并要求重新验证账户；不能在启动、恢复或普通登录时自动申请所有权限。

`POST /api/v2/auth/permissions`，携带当前有效 App access token：

```json
{"client_id":"fire-ios","scope":"profile.write","currentPassword":"当前密码"}
```

`scope` 是本次明确申请的权限；只允许已公布 scope，最终 scope 是原 grant 与请求的并集。`security.write` 必须同时具有或申请 `security.read`；`feed.write` 同理要求 `feed.read`。不允许管理员、文件导出或其他未公布权限。

无需二步时返回 `authenticated`；开启二步时先返回上述挑战结构，`purpose` 为 `permissions`，完成 `/auth/login/totp` 时须携带当前有效、同一 grant 的 Bearer。refresh 后的新 access token 可完成该 grant 的挑战，另一用户或另一 grant 不可。响应中的 `replaces_grant_id` 指向旧 grant。

成功产生新 grant，旧 grant 保留原权限；客户端先原子保存新凭据及 `origin/grant/apiVersion`，切换成功后按原 `auth/revoke` 撤销旧连接。失败、取消、挑战过期或限流都不能清除旧凭据。不要单独保存 access 而丢弃新 refresh，也不要在失败时重放写请求。

## 错误与会话策略

| HTTP | code | 含义 | 客户端行为 |
|---|---|---|---|
| 400 | 40002 | 请求体、类型或固定 client 无效 | 修正请求 |
| 403 | 40103 | 账号密码/当前密码不正确 | 保留旧连接，显示登录错误 |
| 403 | 40104 | 验证码或备用码不正确 | 保留旧连接，可在挑战有效期间重试 |
| 403 | 40105 | 挑战无效、已使用、过期或账户安全状态改变 | 重新开始本次登录/扩权，保留旧连接 |
| 403 | 40301 | 来源或请求权限不允许 | 不降级，不清旧连接 |
| 429 | 42901 | IP、账户、全局或挑战尝试限额 | 等待/重新开始；保留旧连接 |
| 401 | 40101/40102 | 仅扩权时当前 App Bearer 缺失或失效 | 沿用现有连接恢复策略 |
| 500 | 50001 | 操作未完成 | 不清旧连接；凭证消费与 grant 创建原子回滚 |

所有响应统一 `{code,message,data?}`，`Cache-Control: no-store`；不设置 Cookie，不返回 v1 的 `token/expiresIn`，不建立 Web session。password/TOTP/备用码不记录到日志。密码与因子验证预算共用现有登录防护，跨 Web/v1/v2 不形成额外尝试入口。

access 为 15 分钟，refresh 轮换、30 天空闲/90 天最长、重复 refresh 撤销该 token family 等行为与原 `auth/token` 完全一致。新登录令牌也可用于原 v1/v2 资源，客户端仍将 apiVersion 固定为 2，不混用版本。既有 grant 不自动迁移或扩权。

## 服务端验证

`tests/app-native-login.cjs` 的14组回归只使用临时 SQLite，覆盖发现、完整 User 与头像、普通用户权限、Web 会话隔离、请求和共享限流、挑战过期与重放、备用码原子消费、扩权绑定与刷新轮换、异步撤销、设备数量限制和脱敏审计。旧二步密钥成功加密迁移时，仅同步仍对应同一安全状态的 grant/原生挑战摘要绑定，不增加权限、不恢复撤销或旧状态；验证拒绝与内部失败回滚迁移。全量 review、独立类型检查、生产构建与公开/部署审计另行执行；客户端仍需以实际部署发现为准。
