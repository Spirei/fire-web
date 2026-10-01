# Alcor · API 规范（v1）

本文件描述保留的 `/api/v1` 业务字段与语义，旧版 `/api/**` 继续兼容。App 新连接使用独立 [API v2 文档](/api-docs?version=v2)，v1 与 v2 共用业务服务和数据库；部署支持情况以固定发现接口为准。

## 动态（feed）

新增账号独立的 `/api/v1/feed`、指示、任务、喜欢/隐藏和逐帖 AI 讨论。App 明确申请可选 `feed.read feed.write`；默认和旧授权不扩权。完整字段和错误、轮询、媒体、搜索边界见[动态 API 合同](feed-api.md)，共享类型 `lib/feedTypes.ts`。

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | `/api/v1/feed?limit=10&cursor=…` | 本人帖子、下一页游标、指示、任务、能力；默认10条，limit 1–50 |
| PUT | `/api/v1/feed/preferences` | `{instructions,revision,enabled?,intervalMinutes?}`，服务端持久化；旧 revision 返回 409 |
| POST | `/api/v1/feed/refresh` | `{}` → 持久化任务；失败保留历史 |
| GET | `/api/v1/feed/jobs/{id}` | 本人任务 queued/searching/writing/done/error |
| GET | `/api/v1/feed/posts/{id}` | 本人单条动态、来源、喜欢及隐藏状态 |
| PUT | `/api/v1/feed/posts/{id}` | `{liked?:boolean,hidden?:boolean}`，false 可恢复 |
| GET | `/api/v1/feed/posts/{id}/discussion` | `{messages}`，本人最近40条正序讨论 |
| POST | `/api/v1/feed/posts/{id}/discussion` | `{text}`，1–2000字 → 完整讨论；失败不存半个回合 |

读接口需 `feed.read`，写接口需 `feed.write` 且同时有 `feed.read`。时间使用 UTC ISO 8601，发稿日期未知为 null；来源以 `segments[].sourceId` 关联，不解析模型 HTML。小人视频、静态回退和图标地址由能力字段及帖子 icon 返回。离开或进入后台停止任务轮询、暂停小人；不要将尚未提供的真实新闻配图当作已有功能。

## 1. 基础信息

连接地址、请求格式与服务状态。

<details>
<summary>连接与格式 · 接入前必读</summary>

| 项 | 值 |
| --- | --- |
| Base URL | `http://localhost:3000`（生产为 HTTPS 域名） |
| 版本前缀 | `/api/v1` |
| 数据格式 | `application/json`（上传接口 `multipart/form-data`） |
| 健康检查 | `GET /api/health` → `{ code: 0, data: { status: "ok", version } }` |

</details>

## 2. 响应格式

`code` 为 `0` 表示成功，业务数据在 `data` 中。

<details>
<summary>成功 · 读取 data</summary>

```json
{ "code": 0, "message": "ok", "data": { } }
```

</details>

<details>
<summary>分页 · 读取列表与总数</summary>

```json
{
  "code": 0,
  "message": "ok",
  "data": [ ],
  "meta": { "page": 1, "pageSize": 20, "total": 128 }
}
```

</details>

<details>
<summary>失败 · 读取错误码与提示</summary>

```json
{ "code": 40101, "message": "未登录" }
```
失败同时携带 HTTP 状态码（400 / 401 / 403 / 404 / 429 / 500 / 502）。

</details>

## 3. 错误码

按响应 `code` 判断结果。`0` 表示成功。

<details>
<summary>请求与认证 · 参数、会话及权限</summary>

| 分段 | 含义 |
| --- | --- |
| `40001` | 参数无效 |
| `40002` | 请求体无效 |
| `40101` | 未登录 |
| `40102` | 会话失效 |
| `40103` | 用户名或密码错误 |
| `40104` | 二次验证失败（验证码 / 备用码不正确，或 ticket 过期） |
| `40301` | 无权限（需管理员） |
| `40401` | 资源不存在 |
| `40901` | 冲突 / 重复 |
| `42901` | 请求过于频繁（限流） |

</details>

<details>
<summary>服务异常 · 服务器与数据源</summary>

| 错误码 | 含义 |
| --- | --- |
| `50001` | 服务器内部错误 |
| `50002` | 上游数据源失败 |

</details>

## 4. 认证

按接入方式查看。移动端使用 Bearer Token，Web 使用 Cookie。

<details>
<summary>移动端登录 · 获取 Token</summary>

### ① 提交账号密码

```http
POST /api/v1/auth/login
Content-Type: application/json
```

```json
{
  "username": "你的用户名",
  "password": "你的密码"
}
```

**登录成功**：`data` 返回 `token` 和 `expiresIn`（秒），进入第 ③ 步。

**需要二次验证**：返回 `requires2fa: true` 和 `ticket`，进入第 ② 步。

### ② 二次验证（仅开启时）

```http
POST /api/v1/auth/login/totp
Content-Type: application/json
```

```json
{
  "ticket": "上一步返回的 ticket",
  "code": "6 位验证码或一次性备用码"
}
```

验证成功后获取 `token`。

> ticket 有效期 5 分钟，每个账号仅保留最新一张；验证失败 8 次后作废。

### ③ 携带 Token 请求

在后续请求中加入请求头：

```http
Authorization: Bearer <token>
```

### ④ 退出登录

携带同一 Token 调用：

```http
POST /api/v1/auth/logout
Authorization: Bearer <token>
```

</details>

<details>
<summary>Web 登录 · Cookie 会话</summary>

| 场景 | 处理方式 |
| --- | --- |
| 会话 | 使用 HttpOnly Cookie |
| 二次验证 | 先获取 ticket，再调用 `POST /api/auth/login/totp` 验证并写入 Cookie |
| 当前用户 | `GET /api/v1/auth/me`，同时识别 Cookie 与 Bearer Token |

</details>

<details>
<summary>通行密钥 · 注册与登录</summary>

入口：`/api/auth/passkeys`。

| 操作 | 请求 |
| --- | --- |
| 注册 | POST，`action` 为 `register-options` → `register-verify` |
| 登录 | POST，`action` 为 `login-options` → `login-verify` |
| 查看 | GET，返回当前用户的密钥列表 |
| 改名 | PATCH，提交 `{ id, name }` |
| 删除 | DELETE，提交 `{ id, password, code }` |

### 请求与验证

| 阶段 | 字段与要求 |
| --- | --- |
| options 响应 | `{ options, requestId }`，同时写入一次性浏览器绑定 Cookie |
| verify 请求 | `{ action, requestId, response }`；注册可另传 `name` |
| 注册身份 | 已登录、`password`，以及已开启二次验证时的 `code` |
| 登录结果 | 必须通过 WebAuthn 用户验证；成功写入 HttpOnly Cookie，不返回 Bearer Token |

### 删除与会话

- 删除密钥会撤销关联会话及该账号来源不明的升级前旧会话。
- 返回 `{ ok: true, signedOut: boolean }`；`signedOut=true` 时返回登录页。

### 挑战与限流

- 登录 options 写入签名浏览器标识 Cookie，按浏览器及可信代理 IP 分别限流。
- 每个浏览器只保留最新挑战；verify 需要挑战绑定 Cookie，挑战仅可使用一次。

</details>

<details>
<summary>密钥配置 · 管理员设置</summary>

入口：`/api/auth/passkeys/config`。

- **读取**：GET 公开返回 `{ enabled, origin, name, revision }`。
- **保存**：PUT 限管理员，提交配置、`currentPassword`，以及已开启二次验证时的 `code`。
- **版本检查**：网页提交 `expectedRevision`，冲突返回 HTTP 409；兼容旧客户端省略该字段。保存成功返回确认后的配置和版本。
- **校验顺序**：先检查地址，再验证身份。配置未变时保留现有挑战。
- **修改范围**：域名和凭据不能通过普通站点设置或数据导入修改。部署与恢复见 [通行密钥](passkeys.md)。

</details>

## 5. 公共约定

分页、数据格式与请求频率适用于以下接口。

<details>
<summary>分页 · 页码与数量</summary>

```http
?page=1&pageSize=20
```

- `page`：从 1 开始。
- `pageSize`：默认 20，上限 100。
- `meta.total`：返回记录总数。

</details>

<details>
<summary>数据格式 · 金额与日期</summary>

### 金额

金额使用原生币种的数字，不带货币符号。客户端通过以下接口获取汇率后换算：

```http
GET /api/v1/rates
```

### 日期

- 日期：`YYYY-MM-DD`。
- 时间戳：`YYYY-MM-DDTHH:mm:ss.sssZ`（ISO 8601）。

</details>

<details>
<summary>请求频率 · 限流与缓存</summary>

### 每个 IP 的请求上限

- 登录：50 次 / 15 分钟。
- 行情：120 次 / 分钟。
- 搜索：60 次 / 分钟。

> 超过限制返回 `42901`。

### 缓存建议

- 行情与指数：客户端 30 秒内避免重复请求。
- 日／月 K：服务端缓存 10 分钟，缓存各限 128 个结果；相同证券的补零及交易所后缀写法合并在途请求。失败和空历史不缓存，每次返回独立副本。日线按数据源、复权、指数模式与条数隔离。
- 相同或重叠的行情／分时查询按证券合并上游请求，返回键仍使用各客户端传入的 `id`。行情共享结果有效期 2 秒，分时为 30 秒；无数据、失败及标记过期的分时不延长缓存。
- 缓存随行情源／分时接口配置隔离，修改接口后直接读取新来源。共享内容仅为公开市场数据；个人记录、授权凭据和账户响应保持 `no-store, private`。

</details>

## 6. 接口清单

按业务查看接口。每条接口列出方法、路径、用途与所需权限。

### 6.1 认证
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 登录；未开 2FA 返回 user + token，已开 2FA 返回 `{ requires2fa, ticket }` | 无 |
| POST | `/api/v1/auth/login/totp` | 二次验证：ticket + 6 位验证码或备用码，返回 user + token | 无（持有效 ticket） |
| GET | `/api/v1/auth/setup-status` | 空实例是否需要首次管理员设置（`{ needsSetup }`） | 无 |
| GET | `/api/v1/auth/me` | 当前用户 | 登录 |
| PUT | `/api/v1/auth/profile` | 本人昵称、用户名、邮箱部分更新；改邮箱需 currentPassword，开启 TOTP 时需 code | 本人会话；App 需 profile.write |
| PUT | `/api/v1/auth/email` | 本人修改/解绑邮箱，回传完整公开身份 | 有效本人连接 + currentPassword，开启 TOTP 时需 code；不需 profile.write |
| POST | `/api/v1/auth/password` | 本人改密；成功后旧凭据失效并需重新登录 | 有效本人连接 + currentPassword；已开启 TOTP 时还需 code |
| POST | `/api/v1/auth/logout` | 登出 | 登录 |
| POST | `/api/v1/auth/delete-account` | 注销当前账号（body 必须提供 `password`；已开启二次验证时还需 `code`；级联删除其全部数据；保护最后一个管理员） | 登录 + 当前密码 + 可选 TOTP |

### 6.2 资产 / 持仓
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/overview` | 资产总览；`currency` 默认 USD，总额与市场分布均按该币种换算 | 登录 |
| GET | `/api/v1/records` | 持仓记录列表（分页，支持 `market`/`group`） | 登录 |
| POST | `/api/v1/records` | 创建持仓记录 | 登录 |
| PUT | `/api/v1/records/{id}` | 更新持仓记录 | 登录 |
| DELETE | `/api/v1/records/{id}` | 删除持仓记录 | 登录 |
| GET | `/api/v1/orders` | 查询成交订单（支持 `scope` / `recordId`） | 登录 |
| POST | `/api/v1/orders` | 按成交价执行买入 / 卖出并原子更新持仓 | 登录 |
| PUT | `/api/v1/orders/{id}` | 更正成交订单并重放该股票账本、重新计算持仓 | 登录 |
| DELETE | `/api/v1/orders/{id}` | 删除历史成交订单并重放剩余账本、重新计算持仓 | 登录 |
| GET | `/api/v1/watch-groups` | 自选股分组列表（自动播种市场分组 + 迁移旧数据） | 登录 |
| POST | `/api/v1/watch-groups` | 新建自定义分组（body `{ name }`） | 登录 |
| POST | `/api/v1/watch-groups/{id}/icon` | multipart `file` 上传并保存自有分组图标，最大 2MB | 分组所有者 |
| PUT | `/api/v1/watch-groups/{id}` | 更新分组（`name` / `icon` / `visible`） | 登录 |
| DELETE | `/api/v1/watch-groups/{id}` | 删除自定义分组（清空记录归属 + 图标素材） | 登录 |
| POST | `/api/v1/watch-groups/reorder` | 分组整体排序（body `{ order: string[] }`） | 登录 |
| POST | `/api/v1/records/group-assign` | 批量分配 / 移出分组（body `{ ids, groupId }`，groupId 空串 = 移出） | 登录 |
| GET | `/api/v1/orders/export` | 导出订单 xlsx（`scope` / `market` / `status` / `type` / `start` / `end` / `recordId` / `limit`，`detail=1` 追加明细工作表） | 登录 |

持仓写入约束：`name` 必填且不超过 100 字符，`code` 仅接受字母、数字、点、下划线和连字符且不超过 40 字符；`price`（现价）与 `qty`（数量）不可为负数；`cost`（成本价）允许为负数，以支持返佣、期权收入或累计回款超过投入后的负成本持仓。创建与更新采用相同规则，校验失败返回 `40001` 及对应字段提示。

### 6.3 行情 / 数据
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/v1/quotes` | 批量实时行情（≤100 只，body `{ items: [{ id, market, code }] }`） | 无（限流） |
| POST | `/api/v1/charts` | 多市场当日分时走势（≤100 只） | 无（限流） |
| GET | `/api/v1/kline` | 月 K（`?market=US&code=AAPL`） | 登录 |
| GET | `/api/v1/rates` | 汇率（`?refresh=1` 强制刷新） | 登录 |
| GET | `/api/v1/search` | 股票搜索（`?q=`） | 无（限流） |
| GET | `/api/v1/indices` | 全球指数（分市场分组） | 登录 |
| GET | `/api/v1/earnings` | 财报日历（`?month=YYYY-MM&market=US\|CN`） | 无（限流） |
| GET | `/api/v1/stock-detail` | 个股详情（行情 + 六币种市值 + 汇率 + 日 K，个股页数据契约） | 无（限流） |
| GET | `/api/v1/company-profile` | 公司简况（简介、市场、行业、年结日、官网） | 无（限流） |
| GET | `/api/v1/kline-sessions` | 美股当日分时（盘前 / 盘中 / 盘后，美东时间） | 无（限流） |
| GET | `/api/v1/index-kline` | 指数月 K（`?key=spx` 等，东财优先，腾讯 / 雅虎兜底，10 分钟缓存） | 无（限流） |
| GET | `/api/v1/financial-reports` | 财报文件列表（`?market=` / `?exchange=` / `?code=` 过滤） | 无 |
| POST | `/api/v1/financial-reports` | 上传财报文件（multipart，字段含 market / exchange / code / companyName / fiscalYear / fiscalPeriod / reportType） | 管理员 |
| DELETE | `/api/v1/financial-reports/{id}` | 删除财报文件 | 管理员 |

### 6.4 名人持仓
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/celebs` | 名人列表（含持仓明细 / 交易 / 收益概览） | 无 |
| GET | `/api/v1/celebs/{id}` | 单个名人详情 | 无 |
| GET | `/api/v1/celebs/{id}/returns` | 收益分析日线（近 5 年 + 对比指数） | 无 |

### 6.5 素材库 / 上传
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/assets` | 素材列表（`type` / `q` 过滤 + 分页） | 无 |
| GET | `/api/v1/assets/lookup` | 按当前页面所需的素材键精确匹配，最多 50 项 | 无 |
| POST | `/api/v1/assets` | 注册 / 更新素材（upsert 幂等） | 管理员 |
| PUT | `/api/v1/assets/{id}` | 重命名素材 | 管理员 |
| DELETE | `/api/v1/assets/{id}` | 删除素材 | 管理员 |
| POST | `/api/v1/upload` | 文件上传（`kind=avatar/asset/ico/background/logo`） | 登录 / 管理员 |

素材展示优先使用条目的 `imageUrl`（固定 ID + 内容版本），旧服务器没有该字段时使用 `url`。列表读取按 `meta.total` 结束；一个类型失败时保留该类型缓存，其他已成功类型可更新。素材索引与图片缓存按所选服务器隔离。

原生页面图标优先使用 `assets/lookup?keys=<URL 编码的 JSON 数组>`，如 `[{"type":"stock","market":"US","code":"AAPL"},{"type":"market","market":"","code":"US"}]`。键包含 `type`、`market`、`code`；仅接受 `stock / market / crypto / metal`，股票必须提供市场，单次最多 50 项。响应 `data` 为匹配的素材数组，不包含未请求的目录条目；支持交易所后缀及港股补零别名，返回固定 ID 图片地址。查询不播种、不改写素材，按 IP 与全局限流。

App 图标随实际挂载行合并小批请求，不在启动时读取四类完整目录。旧容器返回 404 时只回退 `assets?type=...&q=所需代码` 的定向搜索，再精确过滤；不回退无筛选全目录。离开页面取消独立读取者，最后一个读取者离开才中断共享传输。

### 6.6 券商
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/brokers` | 券商列表（含图标，顺序即展示顺序） | 登录 |
| POST | `/api/v1/brokers` | 全量保存券商列表（覆盖式） | 管理员 |
| DELETE | `/api/v1/brokers?id={id}` | 删除券商（同步清空对应持仓记录的券商） | 管理员 |

### 6.7 设置
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/settings/public` | 公开站点设置（标题 / 图标 / Logo / 注册开关） | 无 |

## 6.8 券商字段

券商 = 分组管理中的券商分组，持仓记录通过 `records.group_name`（券商名称）关联。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 券商唯一 ID（分组 ID，如 `g1785588859092-0`，小写为规范） |
| `name` | string | 券商名称（如 `长桥证劵`），改名时自动同步持仓记录 |
| `alias` | string | 券商别名（如 `盈透证券` → `IBKR`），展示在名称下方小字；无别名时为空字符串 |
| `icon` | string | 券商图标本地 URL（`/uploads/asset/broker/…`）；空字符串表示无图标，客户端用名称首字母兜底 |

**GET /api/v1/brokers 响应示例**
```json
{
  "code": 0,
  "message": "ok",
  "data": [
    { "id": "g1785588859092-0", "name": "长桥证劵", "alias": "Longbridge", "icon": "/uploads/asset/broker/长桥证劵.png" },
    { "id": "g1785588866286-1", "name": "盈透证券", "alias": "IBKR", "icon": "/uploads/asset/broker/IBKR.png" },
    { "id": "g1785588878120-2", "name": "华泰证劵", "alias": "HTSC", "icon": "/uploads/asset/broker/华泰证劵.webp" }
  ]
}
```

**POST /api/v1/brokers 请求体**（全量覆盖，顺序即展示顺序）
```json
{ "groups": [ { "id": "g1785588859092-0", "name": "长桥证劵", "alias": "Longbridge" }, { "id": "g1785588866286-1", "name": "盈透证券", "alias": "IBKR" } ] }
```

**约定**
- 新增券商：生成唯一 `id`（建议 `g{时间戳}-{序号}`），POST 时与 `name` 一起提交；`id` 以小写为准。
- 别名：`alias` 为可选字段（如 IBKR / Schwab / Webull），用于名称下方小字展示；不传或为空表示无别名。
- 重命名：提交相同 `id` 的新 `name`，服务端自动同步所有持仓记录。
- 删除：`DELETE /api/v1/brokers?id={id}` 会同步清空该券商名下持仓记录的券商。
- 图标：素材库「券商图标」tab 上传（`/api/v1/upload` kind=asset + folder=broker，或 Web 端上传），`GET /api/v1/brokers` 自动合并。

## 6.9 个股详情

个股详情页（moomoo 风格：头部行情 + 4 列指标 + 多币种市值 + K 线）的数据统一走该接口，
Web 前端与 iOS App 消费同一份数据，移动端**无需自行做币种换算 / K 线聚合**。

### 请求

`GET /api/v1/stock-detail?market=US&code=AAPL`

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
| `rates` | 对 USD 的汇率（缓存 + 兜底，见 `/api/v1/rates`） |
| `kline` | 日 K（前复权）：`d` 日期 `YYYY-MM-DD`、`o` 开、`h` 高、`l` 低、`c` 收、`v` 量（A股为手，其余为股）；美股 Yahoo 日线（拆股复权）→ 新浪兜底；港股 A股 日韩腾讯 fqkline，A股可兜底东财；少量基准优先富途，10 分钟缓存，最多 320 条 |

完整详情并行读取行情、汇率、K 线，响应等待三路结束；任一路失败只缺对应字段（`quote: null` / `marketCap: null` / `kline: []`），HTTP 仍返回 `code: 0`。

历史曲线使用 `GET /api/v1/stock-detail?market=US&code=AAPL&view=history`，仅返回 `{ market, code, kline }`，跳过实时行情、汇率及 ETF 市值查询。失败返回 HTTP 502 / `50002`，可立即重试。旧容器忽略 `view` 后仍返回完整详情，客户端只读取其中 `kline`，无需新增授权或切换连接。`includeKline=0` 继续用于完整详情的行情读取；`view=history` 时优先返回历史。

月收盘 `/api/v1/kline` 与旧版 `/api/kline` 共用同一数据与缓存；旧版保持 `{ closes }` 并截取最近 12 个月。两者使用规范化代码、有界缓存和在途请求合并；美股并行探测交易所，首个有效结果取消剩余探测，失败继续腾讯兜底。腾讯月线取收盘列而非开盘列；月份升序、去重并与价格一一对应。上游不可用或返回空历史时为 HTTP 502 / `50002`。
周 / 月 K 由客户端对 `kline` 聚合（周：ISO 周首日开 / 末日收 / 高低取极值；月：自然月同理）。

## 6.10 公司简况

Web“公司”页与 iOS App 共用同一份公司资料契约。

### 请求

`GET /api/v1/company-profile?market=US&code=AAPL`

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

## 6.11 分时走势

供 Web 行情板、持仓列表和 iOS 迷你走势图共用。一次最多请求 100 只股票，服务端会按市场选择数据源，并在主数据源缺失时自动回退；单只股票无数据不会导致整批请求失败。

### 请求

`POST /api/v1/charts`

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

证券代码必须按字符串传递并保留前导零：A 股使用六位代码（如世纪华通 `002602`、五粮液 `000858`），港股建议使用五位代码（如腾讯 `00700`）。该规则也适用于 `/api/v1/quotes`，iOS 不应先把代码转换为整数。

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

批量行情 `/api/v1/quotes` 与旧 `/api/quotes` 可传 `"includeMarketCap": false`，跳过额外的 ETF 份额／基金规模补全；已有上游市值仍会返回。省略该字段保持完整报价，供个股详情和 ETF 排序使用。ETF 份额成功缓存 24 小时、失败冷却 6 小时；并发相同代码共用读取，市值按各调用者现价计算，单次补全最多访问 12 个不同证券。

`/api/v1/quotes` 和 `/api/v1/charts` 在客户端接受 gzip 且响应至少 1 KB、压缩可缩小时异步压缩，正确处理 `gzip;q=0`；信封和字段不变。响应为 `Cache-Control: no-store, private` 与 `Vary: Accept-Encoding`，请求 ID 不进入 HTTP 共享缓存，公开市场值只在服务端按证券共享。URLSession／浏览器自动解压。

超过 100 只应拆为最多两个同时进行的滚动批次。网络、限流或上游失败只影响本批，其他批继续返回。App 保留失败批的有效旧值，公开价格回退最长 10 分钟、分时最长 30 分钟，过期／上游旧图不续期；取消、来源切换、证书及权限错误直接结束，不用旧值掩盖。网页失败批保留原价，首帧快照与在途返回都校验记录 ID 对应的市场和代码，修改证券后不会恢复原证券的报价；后台停止未完成的读取。

服务端分时缓存 30 秒，行情结果共享 2 秒。列表页建议只请求当前可见证券（Web 当前每页 6 只）；iOS 前台活跃时建议每 30 秒刷新分时，进入后台或非交易日停止轮询。

- **交易日**：按交易所当地日期计算。美股使用 `America/New_York`，港股与 A 股使用 `Asia/Shanghai`，不按设备时区切换。
- **单股盈亏**：`(最新价 - 昨收价) × 持仓数量`。
- **跨市场汇总**：先按本币计算，再用当前汇率换算到展示币种。
- **刷新**：首次拉取全部市场收盘快照；之后仅在对应市场盘前、盘中或盘后每 30 秒刷新。周末和休市保留最后有效值，不持续请求。

美股当日盈亏覆盖美东盘前、盘中与盘后，并以**美东时间 20:00**作为当天结算边界。到达 20:00 后停止该市场行情轮询、冻结最终当日盈亏并显示“已结算”；下一交易日美东 04:00 盘前恢复更新。不得使用中国时间 20:00 或设备本地午夜切换美股当日盈亏。

- **返回字段**：`price`、`change`、`changePct` 为当前扩展时段有效值，同时返回 `session: PRE | AFTER` 与 `prevClose`。
- **涨跌基准**：最近一次常规盘收盘价。不要直接使用上游 `previousClose` / `chartPreviousClose`，新上市或杠杆 ETF 的该字段可能来自复权前或更早交易日。
- **客户端**：Web、持仓盈亏与 iOS 共用上述字段，保持涨跌口径一致。

美股 K 线会先规范化交易所后缀（例如 `SPCH.AM → SPCH`）。日 K 首选新浪，空数据时自动回退 Yahoo 日线；5 日分钟线同样在新浪缺失时回退 Yahoo 5 分钟线。客户端只消费统一的 `items` / `points`，无需识别上游，适用于新上市 ETF 与美交所证券。

## 6.12 K 线时段

返回美股最近交易日 1 分钟分时数据，时间均为**美东时间**。Web 和 iOS 可按 `session` 字段直接筛选，无需自行推断时段。

### 请求

`GET /api/v1/kline-sessions?market=US&code=AAPL`

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

## 6.13 自选股分组

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

**GET /api/v1/watch-groups** —— 列表（首次访问自动播种市场分组 + 迁移旧数据；`sort` 升序）
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

**POST /api/v1/watch-groups** —— 新建自定义分组
```json
// 请求体
{ "name": "核心持仓" }
// 成功响应（重复名称返回 40901「分组已存在」）
{ "code": 0, "message": "ok", "data": { "group": { "id": "wg-xyz789", "name": "核心持仓", "icon": "", "sort": 7, "visible": -1, "kind": "custom", "market": "" } } }
```

**PUT /api/v1/watch-groups/{id}** —— 更新（字段可选：`name` 重命名 / `icon` 图标 / `visible` 显隐）
```json
// 请求体：重命名 + 显隐
{ "name": "核心持仓", "visible": 1 }
// 请求体：上传 / 清除图标（icon 传空字符串 = 清除）
{ "icon": "/uploads/asset/group/科技.png" }
// 成功响应
{ "code": 0, "message": "ok", "data": { "group": { "id": "wg-xyz789", "name": "核心持仓", "icon": "", "sort": 7, "visible": 1, "kind": "custom", "market": "" } } }
```

**DELETE /api/v1/watch-groups/{id}** —— 删除自定义分组（清空记录归属 + 图标素材；市场分组返回 40001「市场分组不可删除」）
```json
{ "code": 0, "message": "ok", "data": { "deleted": true } }
```

**POST /api/v1/watch-groups/reorder** —— 整体排序（body 传全量分组 id，按数组顺序写入 `sort`）
```json
// 请求体
{ "order": ["wg-abc123", "wg-xyz789", "wg-def456"] }
// 成功响应
{ "code": 0, "message": "ok", "data": { "updated": 3 } }
```

**POST /api/v1/records/group-assign** —— 批量分配 / 移出分组
```json
// 请求体（groupId 传空字符串 = 移出分组；仅可分配到 custom 分组）
{ "ids": ["r-001", "r-002"], "groupId": "wg-xyz789" }
// 成功响应
{ "code": 0, "message": "ok", "data": { "updated": 2 } }
```

**约定**
- 全部接口需登录（`Authorization: Bearer <token>` 或会话 Cookie），未登录返回 `40101`；限流 `42901`。
- 分组数量（count）由客户端用记录计算：市场分组 = `records.market` 匹配数，自定义分组 = `watch_group_id` 匹配数，接口不额外返回。
- 分组图标上传：`POST /api/v1/watch-groups/{id}/icon`（multipart `file`），返回 `{ code: 0, data: { group } }`。服务端校验登录、分组归属及图片内容，完成图标存储和素材注册；不需要再次 PUT。公共素材上传仍仅管理员可用。
- 素材库「分组图标」分类只展示非券商自定义分组（有 `type=broker` 同名图标的券商分组走「券商图标」分类）。

### 行为约定

- 添加股票自动进入「全部 + 对应市场」；市场分组是动态过滤（按 `records.market`），自定义分组才是显式归属（按 `records.watch_group_id`）。
- 删除自定义分组：清空该分组下所有记录的 `watch_group_id`（一条 SQL），并删除图标素材。
- 旧版 `?filter=G:名称` / `M:US` URL 自动迁移到分组 id；分组不存在时回退「全部」。
- 旧 localStorage 分组配置（`fire:watch-groups:v1`）首次加载时一次性同步到服务端并清除。

## 6.14 交易与订单

订单是可审计的成交凭证；持仓记录是订单执行后的最新快照。普通交易只追加订单，录入错误通过专用更正接口修改并重算账本。Web 的持仓一级页只展示组合，点击股票进入二级详情后再执行交易、查看该股票订单。iOS 可直接复用以下接口。

订单录入错误可通过 `PUT /api/v1/orders/{id}` 留痕更正。服务端会按成交时间重放该股票全部已成交订单，重新计算每笔成交后的数量、成本、已实现盈亏以及当前持仓；若更正后任意时点出现超卖，则整次修改回滚并返回 `40001`。

### 查询单只股票订单

```http
GET /api/v1/orders?recordId=r-aapl&scope=today&limit=200
Authorization: Bearer <token>
```

- `scope=today`：按 `tradedAt`（成交时间）归入本地时区当日成交；`history`：按成交时间早于当日；`all`：全部（默认）。`createdAt` 仅表示订单记录写入时间，不参与“当日订单”归类。
- `recordId` 可选；传入后只返回当前用户该条持仓的订单。
- `limit` 为 `1...500`，默认 `200`。

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
POST /api/v1/orders
Content-Type: application/json
Authorization: Bearer <token>

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
DELETE /api/v1/orders/o-123
Authorization: Bearer <token>
```

成功返回 `{ deletedId, position }`。服务端删除目标订单后，会从该股票第一笔成交前的基准持仓开始重放剩余订单，重新计算每笔订单快照和当前持仓；若删除会令后续任一卖出订单超卖，则整次删除回滚并返回 `40001`。该操作不可撤销，客户端应仅在历史订单页提供，并在执行前二次确认。

---

## 6.15 财务报表

财报文件按「市场 + 交易所 + 代码 + 财年 + 财期」归类存储，供财务面板 / F10 使用。

### 列表

```http
GET /api/v1/financial-reports?market=US&code=AAPL
```

返回 `{ reports: [{ id, market, exchange, code, companyName, fiscalYear, fiscalPeriod, reportType, filePath, fileName, createdAt }] }`，支持 `market` / `exchange` / `code` 过滤。

### 上传

```http
POST /api/v1/financial-reports
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

表单字段：`file`（必填，财报文件）、`market`、`exchange`、`code`、`companyName`、`fiscalYear`、`fiscalPeriod`、`reportType`。仅管理员。

### 删除

```http
DELETE /api/v1/financial-reports/fr-123
Authorization: Bearer <token>
```

成功返回 `{ deleted: true }`；不存在返回 `40401`。仅管理员。

## 6.16 指数月 K

```http
GET /api/v1/index-kline?key=spx
```

`key` 支持 `spx`（标普 500）等指数标识（见 INDEX_MAP）。返回 `{ closes: number[], months: ["YYYY-MM", ...] }`，按月收盘价对齐。数据源东财优先，失败依次回退腾讯 / 雅虎，结果缓存 10 分钟；未知指数返回 `40001`，限流返回 `42901`。

## 6.17 订单导出

```http
GET /api/v1/orders/export?scope=all&market=ALL&status=all&type=all&start=&end=&recordId=&limit=5000&detail=1
Authorization: Bearer <token>
```

返回 `.xlsx` 文件，仅登录用户可用。

| 参数 | 说明 |
| --- | --- |
| `scope` | today / history / all |
| `market`、`status`、`type`、`recordId` | 与订单列表筛选一致 |
| `start`、`end` | 委托时间区间 |
| `limit` | 默认 5000，上限 10000 |
| `detail=1` | 追加订单明细表，含成交后持仓数量、成本等 23 列 |

## 6.18 数据备份

```http
GET  /api/v1/data/export
POST /api/v1/data/import
Authorization: Bearer <token>
```

### 导出范围

所有登录用户可用。返回 `fire-site-backup` JSON，包含 `format`、`version`、`appVersion`、`exportedAt`、`manifest`、`data`。

| 用户 | data 内容 |
| --- | --- |
| 普通用户 | 自己的 `userSettings`、`records`、`tradeOrders`、`activities`、`watchGroups`、`profile(nickname)` |
| 管理员 | 另含 `siteSettings` 与 `celebs`；排除数据库连接串等环境键 |

### 导入流程

1. 提交导出文件，最大 10MB；各数据集条数和调用频率另有限制。
2. 调用 `POST /api/v1/data/import?preview=1`，校验结构、字段白名单、版本和引用归属，并试算条数；此步不写入。
3. 正式导入前生成数据库快照，失败则停止。
4. 在单事务内恢复当前用户数据。

### 数据合并规则

- 当前用户已有 ID：更新对应数据。
- 新数据或与其他用户冲突的 ID：生成新 ID，同步重映射订单与分组引用，不改变其他用户的数据归属。
- 管理员可额外导入白名单内的 `site_settings` 与 `celebs`；普通用户携带的站点级数据会被忽略。

## 6.19 资金

```http
GET    /api/v1/funds?limit=100
POST   /api/v1/funds
DELETE /api/v1/funds/{id}
Authorization: Bearer <token>
```

支持 USD / HKD / CNY 多币种现金账本。GET 返回各币种 `balances` 与当前用户的资金记录；POST 字段为 `currency`、`type(opening|deposit|withdrawal|adjustment)`、`amount`、`direction(1|-1)`、`note`、`occurredAt`；DELETE 只能删除当前用户自己的记录。资金记录随网站数据导出/导入迁移。

## 6.20 车型展示

车型导入设置页的上传、参数保存、排序、封面、删除和预览生成全部通过以下 API 完成。除公开清单外，写操作都要求管理员 Cookie 会话、可信同源请求并受频率限制。模型文件通过 `/uploads/**` 静态地址与浏览器 Cache Storage / IndexedDB 加载；镜头、圆盘、线框颜色和部位选择属于逐帧交互，不经过 API。

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/showcase/models` | 读取首页可用车型清单与公开渲染配置 | 无 |
| POST | `/api/showcase/models/upload?name={file.glb}` | 体检或提交保存 GLB，最大 250MB | 管理员 |
| POST | `/api/showcase/models` | 保存新车型及参数并正式上线 | 管理员 |
| PUT | `/api/showcase/models/{id}` | 更新车型名称、年份和渲染参数 | 管理员 |
| DELETE | `/api/showcase/models/{id}?file=1` | 移出车型；`file=1` 同时删除 GLB | 管理员 |
| PUT | `/api/showcase/models/order` | 保存首页车型排列顺序 | 管理员 |
| POST | `/api/showcase/models/cover?id={id}&name={image}` | 上传车型封面，最大 6MB | 管理员 |
| DELETE | `/api/showcase/models/cover?id={id}` | 移除自定义封面 | 管理员 |
| POST | `/api/showcase/models/preview-upload?id=<id>` | 上传本地工具导出的首页轻量预览 | 管理员 |

### GLB 体检与保存

```http
POST /api/showcase/models/upload?name=mp4-6.glb
Content-Type: model/gltf-binary
Cookie: fire_session=<admin-session>

<原始 GLB 二进制请求体>
```

服务端流式写入系统临时目录，检查 GLB 结构、扩展、网格和贴图。体检通过返回 `{ file, bytes, suggested, report }`，不返回持久化 URL；未通过返回 HTTP `422`。所有分支都删除临时文件。工作台直接预览浏览器当前 File 的 Blob 地址，不写持久化缓存。单文件上限 250MB；单 IP 每小时 20 次，全站每小时 40 次。

保存新车型时再次提交原始 GLB，并附加 `X-Showcase-Model` 请求头，值为 `encodeURIComponent(JSON.stringify({ id, label, note, params }))`，编码后不超过 12000 字符。保存成功返回 `{ model }`；文件复制或登记表提交失败会回收本次新文件。取消、离开、保存失败均不保留未保存附件。

### 新建与更新车型参数

```http
POST /api/showcase/models
Content-Type: application/json

{
  "id": "mp4-6",
  "label": "MP4/6",
  "note": "1991",
  "file": "existing-model.glb",
  "params": {
    "length": 4.4,
    "yaw": 0,
    "pitch": 0,
    "wheelPattern": "wheel|tyre"
  }
}
```

此 JSON 接口仅用于登记 uploads 中已有的文件，不用于新附件上传；新附件通过上述上传接口同时提交文件与参数。成功返回 `{ model }`。修改已有导入车型使用 `PUT /api/showcase/models/{id}`，body 可包含 `label`、`note`、`params`；文件名不可通过更新接口替换。请求体上限 256KB，每小时最多 60 次。内置车型不能通过该接口改参数。

### 排序、封面与删除

```http
PUT /api/showcase/models/order
Content-Type: application/json

{ "ids": ["mcl35m", "mp4-6", "mp4-5"] }
```

排序成功返回 `{ order }`；请求体上限 64KB。封面上传把 PNG、JPG 或 WebP 原始二进制放在请求体中，查询参数传车型 `id` 与原始文件名 `name`，成功返回 `{ cover }`；封面上限 6MB，并验证文件内容与扩展名一致。删除车型默认只移出清单并保留素材，传 `?file=1` 时同时删除 uploads 卷内的 GLB，成功返回 `{ removed, fileDeleted }`。

### 上传本地首页预览

`POST /api/showcase/models/preview-upload?id=<车型ID>`，裸 GLB 请求体，`Content-Type: model/gltf-binary`。仅管理员、同源写入，单 IP 每小时 30 次，上限 32 MiB（包括没有 Content-Length 的流式请求）。体检成功后原子替换预览，失败保留旧预览；支持内置和导入车型。返回 `{ "preview": "/uploads/mclaren/previews/...glb?v=..." }`。

模型高清优化版通过原有车型导入流程上传；KTX2、Meshopt 和 WebP 由现有查看器读取。压缩已迁到独立本地工具，原 `/api/showcase/models/previews` 生成/查询接口已移除，不再启动后台任务。

## 7. 快速上手（移动端）

选择客户端接入方式，再查看所需业务示例。

<details>
<summary>iOS · URLSession + Codable</summary>

### ① 解析响应

用 Codable 解析 `code`、`message`、`data`；`code == 0` 表示成功。

### ② 携带认证

获取 Token 后，使用 URLSession 发起请求并附加：

```http
Authorization: Bearer <token>
```

</details>

<details>
<summary>Android · Retrofit + Gson</summary>

### ① 设置地址

BaseUrl 指向服务域名下的 `/api/v1/`，保留末尾斜线。

### ② 解析响应

定义 `ApiResponse<T>` 泛型承载响应，`code == 0` 表示成功。

</details>

<details>
<summary>资产总览 · 币种与估值</summary>

```http
GET /api/v1/overview?currency=USD
```

### 币种

- 默认美元，支持汇率表内币种。
- `totalCost`、`totalMarket`、`totalPnl` 和 `byMarket` 的金额均使用响应 `currency`，不要再次按市场本币换算。
- `totalMarket` 仍仅证券市值。新增 `totalAsset`（含现金总资产）、`totalCash`（有符号现金），同样使用 `currency`；计算复用 Web `lib/accountCash.ts`，返回前才统一舍入到两位。

### 估值

- 优先实时行情，缺失时使用记录价格。
- `valuation` 返回每条记录的 `id`、`source`（quote / record）和 `at`。
- 无法换算的记录列入 `unconverted`。当 `complete=false` 时，提示汇总不完整。

### 含现金总资产

- 现金含资金账本、已成交订单现金和已持有借记卡/预付卡余额一次，不含信用额度。保留负现金，不从总资产扣掉挂单冻结金额。
- 已导入简化主账户权益按 Web 原有市场/结算币种规则使用 `权益 − 当前持仓 + 银行卡现金`，不累加其他券商。报价改变时现金可能反向改变，客户端应直接读取服务端总资产，不能用静态现金加新报价。
- 新字段：`totalAsset: number|null`、`totalCash: number|null`、`totalAssetComplete: boolean`、`cashComplete: boolean`、`unconvertedCurrencies: string[]`。缺 FX 不按 1:1；现金来源异常/损坏时 totalCash/totalAsset 为 null；持仓 FX 不完整时 totalAsset 为 null，即使 cashComplete=true。原 `complete/unconverted` 仍只描述持仓 FX。
- 无法识别现金来源标记 `UNKNOWN`；未知市场为 `UNKNOWN:市场`。已有明确汇率兜底与 Web 一致。新接口只读派生历史订单现金，不修补真实资金表。
- 建议 App 前台 30 秒、回前台/首页或下拉刷新；账户响应不缓存。休市仍读取现金变化，历史走势无现金快照时保持「持仓市值」标签。

</details>

<details>
<summary>车型展示 · 首页显隐</summary>

仅管理员可调用，支持内置和导入车型。

```http
PATCH /api/showcase/models/{id}
```

```json
{ "hidden": true }
```

- `true`：隐藏；`false`：恢复首页显示。
- 设置写入车型登记表，不删除模型文件或参数。
- 隐藏车型不出现在首页和公开清单中，也不加载或预载模型。
- 全部隐藏时，首页显示空状态。

</details>

> 新功能统一使用 `/api/v1/**`。旧版 `/api/**` 返回裸数据（`{ error }` 或直接资源），不要混用响应格式。

## 8. 原生 App 网页连接

原生 App 推荐通过系统浏览器授权连接，无需在 App 内收取密码。首先从用户选择的服务器读取 `GET /api/v1/auth/config`；返回版本、client_id、固定回调、scope、S256 与同源相对端点。官方域名和自部署域名共用此合同，非默认 HTTPS 端口受支持。生产站点须配置公网域名或 `FIRE_APP_ORIGIN`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/auth/config` | 公开连接发现 |
| GET | `/app/authorize` | 网页登录、查看账户并确认权限 |
| POST | `/api/v1/auth/authorize` | 仅同源浏览器 Cookie 同意/拒绝；返回一次性回调地址 |
| POST | `/api/v1/auth/token` | 授权码 + verifier 换令牌，或轮换刷新令牌 |
| POST | `/api/v1/auth/revoke` | 凭当前 refresh token 撤销整个设备连接 |
| GET / DELETE | `/api/v1/auth/devices` | 浏览器本人查看/撤销设备，DELETE body `{ id }` |
| PUT | `/api/v1/auth/profile` | profile.write：部分更新本人 username/nickname/email；邮箱改变需 currentPassword，开启 TOTP 时需 code |
| PUT | `/api/v1/auth/email` | 有效本人连接自助改邮箱/解绑；currentPassword 必填，开启 TOTP 时需 code，直接回传 User |
| POST | `/api/v1/auth/password` | 有效本人连接自助改密；currentPassword/newPassword/code，撤销本人旧凭据 |
| POST | `/api/v1/upload` | profile.write：multipart kind=avatar,file；仅本人头像 |

身份通过 `GET /api/v1/auth/me` 与 Web 共用既有 `users`；显式获得 `profile.write` 的连接可编辑本人资料和头像。任何有效本人连接均可在专用邮箱/密码接口验证账号凭据后自助操作，不要求管理员或投资写权限；TOTP、通行密钥与设备管理仍保持网站安全设置。资料未提交字段保留，不接受 ID/UID/角色/密码/任意头像地址等额外字段。邮箱验证状态和恢复凭据沿用网站失效规则，修改不等于验证。头像 JPG/PNG/GIF/WEBP、5 MiB，拒绝 SVG 和共享素材上传。

me/profile/email 的 `data` 都是直接 User（非 `{user:...}`），新增 `scope` 及 `capabilities: { profileWrite, avatarUpload, emailWrite, passwordWrite, overviewTotalAssets }`、`security: { twoFactorEnabled }`。上传返回 `data: {url,kind}`。无 profile.write 的 grant 仍不能通用编辑资料/头像，但可验证凭据后使用专用邮箱/密码接口；不从浏览器 Cookie 补权。邮箱密码错误40301、用户名/邮箱冲突40901、参数错误40001、限流42901；所有响应禁止缓存。

邮箱请求 `{email,currentPassword,code?}`，email 空字符串可解绑，即使未变也验证密码，开启TOTP时code必填（失败40301）；通用v1 profile改邮箱同样检查。改密请求 `{currentPassword,newPassword,code?}`，新密码8–128位且含字母、数字，开启TOTP时code必填（验证码或一次性备份码）。改密成功 `data: {ok:true,signedOutOthers:true,reauthenticationRequired:true,user:User}`，在同一事务内修改密码并撤销本人全部Web/App旧凭据及未兑换code，不回传新令牌；App收到明确成功后清除旧连接并重新登录。错误密码HTTP403/code40103、TOTP失败HTTP403/code40104不是连接过期；连接失效40101、存储失败50001。异步读取后重新认证，16KiB体积与账号/来源/全站限流，失败完整回滚，审计不保存密码/因子。详细重试与Web兼容合同见 App 连接说明。

App 使用 `client_id=fire-ios`，`redirect_uri=com.fire.app:/oauth/callback`，`response_type=code` 和 PKCE `S256`。默认仍为 `portfolio.read portfolio.write`，可申请只读；发现接口 `scope` 保留默认值，`scopes_supported` 公布可选 `profile.write`，并返回 `profile_path/upload_path/email_path/password_path`。必须始终包含 portfolio.read；通用资料/头像编辑连接明确加 profile.write 并重新取得网页同意。旧 grant 和刷新不会增加 scope；专用邮箱/密码自助由账号凭据验证，不继承站点管理权。

```json
{
  "grant_type": "authorization_code",
  "client_id": "fire-ios",
  "redirect_uri": "com.fire.app:/oauth/callback",
  "code": "fac_<一次性授权码>",
  "code_verifier": "<本机生成的43至128位随机值>"
}
```

成功仍使用 v1 信封，data 为 `{ access_token, refresh_token, token_type: "Bearer", expires_in: 900, grant_id, scope }`。refresh 请求为 `{ grant_type: "refresh_token", client_id: "fire-ios", refresh_token }`，每次成功必须原子替换两个令牌。授权码 60 秒有效；刷新 30 天无活动失效，授权绝对最长 90 天。旧 refresh 重放、设备撤销、改密和 TOTP 变更使整组凭据失效。

完整流程、迁移、权限与本次 API 审查见 [App 连接说明](./app-connection.md)。旧用户名密码 Bearer 登录接口保留兼容，网页活跃续期仅适用于 Cookie，不续期旧移动端会话。


## 休市日历能力发现

`auth/config` 的 `data.market_calendar` 指向固定同源 `/api/v2/market-calendar`，api_version=2、access=public，列出市场、时区、交易所、已核实年份及结构/数据版本。休市日历只提供 v2；完整请求、缓存、未知状态与日期语义见 API 文档 v2。后续新 App 功能统一使用 v2，既有 v1 连接继续兼容。
