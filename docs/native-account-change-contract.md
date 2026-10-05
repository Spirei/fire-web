# App 分步修改密码与邮箱（合同版本 1）

本次只实现源码，不部署生产。客户端必须读取 `GET /api/v1/auth/config` 或 `/api/v2/auth/config` 的 `data.security.account_change`，仅在 `version === 1` 且对应路径明确存在时启用；不能猜测端点或回退到绕过旧接口验证。路径均为同源相对地址。

所有步骤使用真实 App Bearer access token，需要 `security.write`。Cookie 不可替代。v1/v2 共用状态和限额。所有请求 JSON，只接受下述字段，不接受 userId、grantId、密码/TOTP 以外的额外字段。

| 步骤 | 固定路径（v1 与 v2 都提供） | 请求 | 成功 data |
|---|---|---|---|
| 验证原密码 | POST `/api/v{1或2}/auth/password-change/verify` | `{currentPassword:string}` | `{ok:true,proof:string,expiresAt:number}` |
| 设置新密码 | POST `/api/v{1或2}/auth/password-change/confirm` | `{proof:string,newPassword:string}` | `{ok:true,reauthenticationRequired:true}` |
| 发送当前邮箱验证码 | POST `/api/v{1或2}/auth/email-change/request` | `{}` | `{ok:true,challenge:string,expiresAt:number,retryAfter:60}` |
| 验证当前邮箱 | POST `/api/v{1或2}/auth/email-change/verify` | `{challenge:string,code:string}`（六位数字，保留前导零） | `{ok:true,proof:string,expiresAt:number}` |
| 设置新邮箱 | POST `/api/v{1或2}/auth/email-change/confirm` | `{proof:string,email:string}` | `{ok:true,reauthenticationRequired:true}` |

响应外壳沿用 `{code:0,message:"ok",data:...}`；失败外壳 `{code:number,message:string}`。时间为 Unix 毫秒。凭证随机 32 字节 base64url（43 字符），数据库只存摘要。challenge 与 proof 各五分钟有效；proof 一次性绑定用途、本人、发起 grant、账户身份版本及安全状态，刷新 access token但仍是同一 grant可继续；另一 grant 不可使用。验证原密码不会消耗 TOTP，验证邮箱也不需要密码/TOTP。发送只送到数据库当前绑定邮箱，不接收客户端指定收件人；没有邮箱返回40902，SMTP未配置50301，发送失败 HTTP502/50002且凭证失效。

重发冷却60秒按用户持久保存，跨 grant/版本/重启共享；每用户5次/15分钟、10次/24小时。额外共用 SMTP 收件人预算：1次/分钟、8次/小时、20次/日，verification类5次/小时、10次/日，全站100次/小时、500次/日。发送失败也计额度。成功重发使该用户之前的邮箱 challenge 与 proof失效；验证码最多5次错误尝试，失败次数事务提交，成功后立即失效。新验证密码会替换该用户原有密码proof。

所有步骤还限每用户每用途30次/15分钟，IP100次/15分钟，全站500次/15分钟。42901表示限流；40101/40102表示登录失效；40301表示缺少授权；403/40103表示原密码错误；40003表示challenge/proof错误、到期、账户已变或用途不符；40901表示新邮箱被占用，40902表示新旧邮箱相同。格式错误40001。新密码沿用服务端密码规则；新邮箱不能为空，规范化为小写。格式或邮箱冲突失败不消费有效proof。

成功提交在单一事务内更新身份、消费proof，并撤销全部Web会话、App grants、待授权code；当前grant也失效，不续签、不增加scope。客户端收到成功后清除凭据并进入重新登录。新邮箱保持未验证，需要之后走既有邮箱验证流程，不能继承原邮箱的verified状态。任何途径改变邮箱/密码都会递增身份版本，即使改回原值也不能复活旧凭证；TOTP状态改变、grant撤销也使凭证失效。

原 `/auth/password`、`/auth/email` 及Web接口保留原密码/因子要求，不修改旧合同。此文件为Web合同的单一维护来源。

## 完整能力发现 JSON（v2 示例）

```json
{
  "security": {
    "account_change": {
      "version": 1,
      "write_scope": "security.write",
      "proof_ttl_seconds": 300,
      "password": {
        "verify_path": "/api/v2/auth/password-change/verify",
        "confirm_path": "/api/v2/auth/password-change/confirm",
        "verification": "current_password",
        "requires_totp": false
      },
      "email": {
        "request_path": "/api/v2/auth/email-change/request",
        "verify_path": "/api/v2/auth/email-change/verify",
        "confirm_path": "/api/v2/auth/email-change/confirm",
        "verification": "current_email_code",
        "code_digits": 6,
        "challenge_ttl_seconds": 300,
        "retry_after_seconds": 60,
        "max_attempts": 5,
        "requires_password": false,
        "requires_totp": false
      },
      "reauthentication_required": true
    }
  }
}
```

上面是 config 的 `data` 内局部字段，不是顶层响应；v1只有路径中的v2变为v1，合同version仍为1。confirm成功仅返回`ok`与`reauthenticationRequired`，不返回user或signedOutOthers。所有新流程响应为`Cache-Control: private, no-store`。
