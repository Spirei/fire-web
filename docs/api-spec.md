# Fire · API 规范（v1）

> 面向移动端（Swift / Android）与全站前端的统一接口规范。旧版 `/api/**` 接口保持兼容、逐步迁移到 `/api/v1/**`。

## 1. 基础信息

| 项 | 值 |
| --- | --- |
| Base URL | `http://localhost:3000`（生产为 HTTPS 域名） |
| 版本前缀 | `/api/v1` |
| 数据格式 | `application/json`（上传接口 `multipart/form-data`） |
| 健康检查 | `GET /api/health` → `{ code: 0, data: { status: "ok", version } }` |

## 2. 统一响应信封

所有 v1 接口返回统一结构：

**成功**
```json
{ "code": 0, "message": "ok", "data": { } }
```

**分页列表**
```json
{
  "code": 0,
  "message": "ok",
  "data": [ ],
  "meta": { "page": 1, "pageSize": 20, "total": 128 }
}
```

**失败**
```json
{ "code": 40101, "message": "未登录" }
```
失败同时携带 HTTP 状态码（400 / 401 / 403 / 404 / 429 / 500 / 502）。

## 3. 错误码

| 分段 | 含义 |
| --- | --- |
| `0` | 成功 |
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
| `50001` | 服务器内部错误 |
| `50002` | 上游数据源失败 |

## 4. 认证

移动端推荐 Bearer Token：

1. `POST /api/v1/auth/login`，请求体 `{ "username": "你的用户名", "password": "你的密码" }`
2. 未开启二次验证时，响应 `data` 携带 `token` 与 `expiresIn`（秒）
3. 已开启二次验证时，密码正确不签发 token，返回 `{ "requires2fa": true, "ticket": "…" }`（ticket 5 分钟有效、同一账号只保留最新一张）；接着 `POST /api/v1/auth/login/totp`，请求体 `{ "ticket", "code" }`（`code` 为 6 位 TOTP 或一次性备用码），成功后再拿到 `token`。ticket 校验失败 8 次作废。
4. 后续请求头携带 `Authorization: Bearer <token>`
5. 退出：`POST /api/v1/auth/logout`（携带同一 token）

Web 端继续使用 httpOnly Cookie 会话，两种方式等价，`GET /api/v1/auth/me` 均可识别。开启二次验证后，网页登录同样先返回 ticket，再由 `POST /api/auth/login/totp` 写入会话 Cookie。

## 5. 公共约定

- **分页**：`?page=1&pageSize=20`（page 从 1 开始，pageSize 默认 20、上限 100），响应 `meta` 带回 total。
- **金额**：统一为数字（元 / 美元等原生币种），不携带货币符号；汇率换算由客户端按 `GET /api/v1/rates` 处理。
- **日期**：统一 `YYYY-MM-DD`；时间戳 `YYYY-MM-DDTHH:mm:ss.sssZ`（ISO 8601）。
- **限流**：登录 50 次/15 分钟/IP；行情类 120 次/分钟/IP；搜索 60 次/分钟/IP；被限流返回 `42901`。
- **缓存**：行情 / 指数类接口建议客户端 30s 内不重复请求；K 线服务端缓存 10 分钟。

## 6. 路由清单（v1）

### 6.1 认证
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 登录；未开 2FA 返回 user + token，已开 2FA 返回 `{ requires2fa, ticket }` | 无 |
| POST | `/api/v1/auth/login/totp` | 二次验证：ticket + 6 位验证码或备用码，返回 user + token | 无（持有效 ticket） |
| GET | `/api/v1/auth/setup-status` | 空实例是否需要首次管理员设置（`{ needsSetup }`） | 无 |
| GET | `/api/v1/auth/me` | 当前用户 | 登录 |
| POST | `/api/v1/auth/logout` | 登出 | 登录 |
| POST | `/api/v1/auth/delete-account` | 注销当前账号（body 必须提供 `password`；级联删除其全部数据；保护最后一个管理员） | 登录 + 当前密码 |

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
| POST | `/api/v1/quotes` | 批量实时行情（≤100 只，body `{ items: [{ id, market, code }] }`） | 登录 |
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
| POST | `/api/v1/assets` | 注册 / 更新素材（upsert 幂等） | 管理员 |
| PUT | `/api/v1/assets/{id}` | 重命名素材 | 管理员 |
| DELETE | `/api/v1/assets/{id}` | 删除素材 | 管理员 |
| POST | `/api/v1/upload` | 文件上传（`kind=avatar/asset/ico/background/logo`） | 登录 / 管理员 |

### 6.6 券商 Brokers
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/brokers` | 券商列表（含图标，顺序即展示顺序） | 登录 |
| POST | `/api/v1/brokers` | 全量保存券商列表（覆盖式） | 管理员 |
| DELETE | `/api/v1/brokers?id={id}` | 删除券商（同步清空对应持仓记录的券商） | 管理员 |

### 6.7 设置
| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/settings/public` | 公开站点设置（标题 / 图标 / Logo / 注册开关） | 无 |

## 6.8 券商 Brokers（数据模型）

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

## 6.9 个股详情 Stock Detail（Web / iOS 共用契约）

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
| `kline` | 日 K（前复权）：`d` 日期 `YYYY-MM-DD`、`o` 开、`h` 高、`l` 低、`c` 收、`v` 量（A股为手，其余为股）；美股新浪源 / 港股 A股 日韩 腾讯 fqkline，10 分钟缓存，最多 320 条 |

行情、汇率、K 线三路并行拉取互不阻塞：任一路失败只缺对应字段（`quote: null` / `marketCap: null` / `kline: []`），HTTP 仍返回 `code: 0`。
周 / 月 K 由客户端对 `kline` 聚合（周：ISO 周首日开 / 末日收 / 高低取极值；月：自然月同理）。

## 6.10 公司简况 Company Profile

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

## 6.11 多市场分时走势 Intraday Charts

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

服务端行情缓存 30 秒。列表页建议只请求当前可见证券（Web 当前每页 6 只）；iOS 前台活跃时建议每 30 秒刷新一次，进入后台或非交易日停止轮询。

多市场持仓的“当日盈亏”必须按**交易所当地交易日**计算，不能按设备所在时区的自然日统一切换：美股以 `America/New_York` 为准，港股与 A 股以 `Asia/Shanghai` 为准。单股口径为 `(最新价 - 昨收价) × 持仓数量`；混合市场汇总时先按各市场本币计算，再用当前可用汇率换算到展示币种。Web 首次进入拉取全部市场收盘快照，之后仅在对应市场盘前、盘中或盘后时段每 30 秒刷新；周末及休市时保留最后有效值，不持续请求。

美股当日盈亏覆盖美东盘前、盘中与盘后，并以**美东时间 20:00**作为当天结算边界。到达 20:00 后停止该市场行情轮询、冻结最终当日盈亏并显示“已结算”；下一交易日美东 04:00 盘前恢复更新。不得使用中国时间 20:00 或设备本地午夜切换美股当日盈亏。

美股盘前 / 盘后行情返回时，`price`、`change`、`changePct` 为当前扩展时段有效值，并附带 `session: PRE | AFTER` 与 `prevClose`。涨跌基准固定使用最近一次**常规盘收盘价**；不得直接采用扩展行情源的 `previousClose` / `chartPreviousClose` 元数据，因为新上市或杠杆 ETF 可能返回复权前或更早交易日数据。Web、持仓盈亏与 iOS 必须直接复用这组统一字段，避免详情页上涨而持仓仍显示下跌。

美股 K 线会先规范化交易所后缀（例如 `SPCH.AM → SPCH`）。日 K 首选新浪，空数据时自动回退 Yahoo 日线；5 日分钟线同样在新浪缺失时回退 Yahoo 5 分钟线。客户端只消费统一的 `items` / `points`，无需识别上游，适用于新上市 ETF 与美交所证券。

## 6.12 K 线时段 Kline Sessions

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

## 6.13 自选股分组 Watch Groups（方案 A：独立分组实体）

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

## 6.14 持仓交易与订单 Orders

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

成功返回 `{ order, position }`。买入成本按“原持仓成本额 + 本次成交额 + 费用”加权；卖出采用券商常见的摊薄 / 保本成本口径：`剩余成本 = (卖出前数量 × 卖出前成本 − 卖出数量 × 成交价) ÷ 剩余数量`，因此亏损卖出会提高剩余成本，盈利卖出会降低成本，累计回款超过投入时成本可为负数。成交后持仓成本统一保留 3 位小数，后续持仓盈亏也使用这个可见成本计算，避免隐藏小数位造成对账差额。卖出费用只计入 `realizedPnl = (成交价 - 卖出前成本) × 数量 - 费用`，避免在剩余成本与已实现盈亏中重复计算。订单同时返回 `positionQtyBefore` / `positionCostBefore` 及成交后快照，供 iOS 审计和可靠重放。卖出数量超过持仓时返回 `40001`，订单写入与持仓更新在同一数据库事务内完成。

### 删除历史订单

```http
DELETE /api/v1/orders/o-123
Authorization: Bearer <token>
```

成功返回 `{ deletedId, position }`。服务端删除目标订单后，会从该股票第一笔成交前的基准持仓开始重放剩余订单，重新计算每笔订单快照和当前持仓；若删除会令后续任一卖出订单超卖，则整次删除回滚并返回 `40001`。该操作不可撤销，客户端应仅在历史订单页提供，并在执行前二次确认。

---

## 6.15 财务报表 Financial Reports

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

## 6.16 指数月 K Index Monthly Kline

```http
GET /api/v1/index-kline?key=spx
```

`key` 支持 `spx`（标普 500）等指数标识（见 INDEX_MAP）。返回 `{ closes: number[], months: ["YYYY-MM", ...] }`，按月收盘价对齐。数据源东财优先，失败依次回退腾讯 / 雅虎，结果缓存 10 分钟；未知指数返回 `40001`，限流返回 `42901`。

## 6.17 订单导出 Orders Export

```http
GET /api/v1/orders/export?scope=all&market=ALL&status=all&type=all&start=&end=&recordId=&limit=5000&detail=1
Authorization: Bearer <token>
```

返回 `.xlsx` 二进制（手写零依赖写入器）。筛选参数与订单列表一致：`scope`（today / history / all）、`market`、`status`、`type`、`start` / `end`（委托时间区间）、`recordId`、`limit`（默认 5000，上限 10000）；`detail=1` 时追加「订单明细」工作表（含成交后持仓数量、成本等 23 列）。仅登录用户。

## 6.18 网站设置/数据 导出导入 Site Backup

```http
GET  /api/v1/data/export
POST /api/v1/data/import
Authorization: Bearer <token>
```

- **导出**：返回 `fire-site-backup` 版本化 JSON（`format` / `version` / `appVersion` / `exportedAt` / `manifest` / `data`）。`data` 含当前用户的：`userSettings`、`records`、`tradeOrders`、`activities`、`watchGroups`、`profile(nickname)`；**管理员额外含** `siteSettings`(全部站点设置，排除数据库连接串等环境键) 与 `celebs`(名人持仓)。普通用户仅自己的数据。所有登录用户可用。
- **导入**：body 为导出文件，最大 10MB，并限制各数据集条数和调用频率。`POST /api/v1/data/import?preview=1` 做**结构、字段白名单、版本、引用归属校验 + 试算条数**（不写入）；正式导入前必须成功生成数据库快照，否则停止。导入在单事务内恢复当前用户数据：与当前用户已有 ID 匹配时更新；新数据或与其他用户冲突的 ID 会生成新 ID，并同步重映射订单/分组引用，绝不会改变其他用户的数据归属。管理员可额外导入固定白名单内的 `site_settings` 与 `celebs`；普通用户携带的站点级数据会被忽略。

## 6.19 资金系统 Funds

```http
GET    /api/v1/funds?limit=100
POST   /api/v1/funds
DELETE /api/v1/funds/{id}
Authorization: Bearer <token>
```

支持 USD / HKD / CNY 多币种现金账本。GET 返回各币种 `balances` 与当前用户的资金记录；POST 字段为 `currency`、`type(opening|deposit|withdrawal|adjustment)`、`amount`、`direction(1|-1)`、`note`、`occurredAt`；DELETE 只能删除当前用户自己的记录。资金记录随网站数据导出/导入迁移。

## 6.20 车型展示管理 Showcase Models

车型导入设置页的上传、参数保存、排序、封面、删除和预览生成全部通过以下 API 完成。除公开清单外，写操作都要求管理员 Cookie 会话、可信同源请求并受频率限制。模型文件通过 `/uploads/**` 静态地址与浏览器 Cache Storage / IndexedDB 加载；镜头、圆盘、线框颜色和部位选择属于逐帧交互，不经过 API。

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/showcase/models` | 读取首页可用车型清单与公开渲染配置 | 无 |
| POST | `/api/showcase/models/upload?name={file.glb}` | 上传并体检 GLB 草稿，最大 260MB | 管理员 |
| POST | `/api/showcase/models` | 保存新车型及参数并正式上线 | 管理员 |
| PUT | `/api/showcase/models/{id}` | 更新车型名称、年份和渲染参数 | 管理员 |
| DELETE | `/api/showcase/models/{id}?file=1` | 移出车型；`file=1` 同时删除 GLB | 管理员 |
| PUT | `/api/showcase/models/order` | 保存首页车型排列顺序 | 管理员 |
| POST | `/api/showcase/models/cover?id={id}&name={image}` | 上传车型封面，最大 6MB | 管理员 |
| DELETE | `/api/showcase/models/cover?id={id}` | 移除自定义封面 | 管理员 |
| POST | `/api/showcase/models/previews` | 异步启动首页轻量预览批量生成 | 管理员 |
| GET | `/api/showcase/models/previews` | 查询预览生成任务状态 | 管理员 |

### 上传 GLB 草稿

```http
POST /api/showcase/models/upload?name=mp4-6.glb
Content-Type: model/gltf-binary
Cookie: fire_session=<admin-session>

<原始 GLB 二进制请求体>
```

服务端以流式方式写入草稿，不把整份文件读进内存；随后检查 GLB 结构、扩展、网格和贴图。通过后返回 `{ file, url, bytes, suggested, report }`，未通过返回 HTTP `422` 并删除草稿。只接受安全文件名的 `.glb`，单文件上限 260MB；单 IP 每小时 20 次，全站每小时 40 次。

### 新建与更新车型参数

```http
POST /api/showcase/models
Content-Type: application/json

{
  "id": "mp4-6",
  "label": "MP4/6",
  "note": "1991",
  "file": "draft-example.glb",
  "params": {
    "length": 4.4,
    "yaw": 0,
    "pitch": 0,
    "wheelPattern": "wheel|tyre"
  }
}
```

新建成功返回 `{ model }`，并将对应草稿原子转为正式模型。修改已有导入车型使用 `PUT /api/showcase/models/{id}`，body 可包含 `label`、`note`、`params`；文件名不可通过更新接口替换。请求体上限 256KB，每小时最多 60 次。内置车型不能通过该接口改参数。

### 排序、封面与删除

```http
PUT /api/showcase/models/order
Content-Type: application/json

{ "ids": ["mcl35m", "mp4-6", "mp4-5"] }
```

排序成功返回 `{ order }`；请求体上限 64KB。封面上传把 PNG、JPG 或 WebP 原始二进制放在请求体中，查询参数传车型 `id` 与原始文件名 `name`，成功返回 `{ cover }`；封面上限 6MB，并验证文件内容与扩展名一致。删除车型默认只移出清单并保留素材，传 `?file=1` 时同时删除 uploads 卷内的 GLB，成功返回 `{ removed, fileDeleted }`。

### 生成首页预览

预览接口只生成首页所需的轻量 `.glb`；模型展示与工作台继续读取原始高清模型。任务在服务端异步执行，客户端启动后应轮询状态，不需要维持一个长请求。

#### 启动生成任务

```http
POST /api/showcase/models/previews
Cookie: fire_session=<admin-session>
```

返回 HTTP `202`。没有任务运行时创建新任务；已有任务运行时直接返回同一任务，不会并行重复压缩。

```json
{
  "status": "running",
  "count": 0,
  "startedAt": 1789948800000
}
```

仅管理员可调用，并校验同源写请求。单 IP 每小时最多启动 6 次、全站每小时最多 12 次；超过限制返回 HTTP `429` 与 `{ "error": "生成操作过于频繁，请稍后再试" }`。

#### 查询任务状态

```http
GET /api/showcase/models/previews
Cookie: fire_session=<admin-session>
Cache-Control: no-cache
```

`status` 取值为 `idle`、`running`、`done` 或 `error`。完成时 `count` 是可用预览模型数量，并返回 `finishedAt`；失败时返回截断后的 `error` 信息。建议运行期间每秒轮询一次，进入 `done` 或 `error` 后停止。

```json
{
  "status": "done",
  "count": 4,
  "startedAt": 1789948800000,
  "finishedAt": 1789948824000
}
```

该接口沿用现有 Web 管理端的裸 JSON 响应格式，不属于对移动端公开的 `/api/v1/**` 契约。

## 7. 快速上手（移动端）

**Swift（URLSession + Codable）**：请求统一解析 `{ code, message, data }`，`code == 0` 视为成功；认证头 `Authorization: Bearer <token>`。

**Android（Retrofit + Gson）**：定义 `ApiResponse<T>` 泛型，`code == 0` 判成功；BaseUrl 指向 `/api/v1/`。

旧版 `/api/**` 接口响应为裸数据（`{ error }` 或直接资源），v1 为唯一规范入口，新功能只进 v1。

### 资产总览币种与估值口径

`GET /api/v1/overview?currency=USD` 默认美元；支持汇率表内币种。
`totalCost`、`totalMarket`、`totalPnl` 和 `byMarket` 内金额均使用响应 `currency`，不得再次按市场本币换算。
优先实时行情，缺失时用记录价格；`valuation` 返回每条记录的 `id`、`source`（quote/record）和 `at`。
无法换算的记录列入 `unconverted`，此时 `complete=false`，客户端应提示汇总不完整。
