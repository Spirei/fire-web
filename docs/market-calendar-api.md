# Alcor 三地休市日历 · iOS v2 合约

新增 App 功能统一使用 v2；休市日历没有 v1 端点。Web 与 API 共用 `lib/marketCalendar.ts` 的年度安排，不建立另一套账户或行情数据。

## 请求和认证

`GET /api/v2/market-calendar?market=US&year=2026`

- `market` 必填，精确大写 `CN` / `HK` / `US`，不可重复。
- `year` 必填，四位整数 2000–2100，不可重复；仅 2026 已核实。合法但未收录年份返回 HTTP 200、未知覆盖状态，不猜测交易日。
- 公开只读，可匿名调用，无新增 scope。Cookie 不提供身份；显式 Bearer 必须是有效 App access token。异源 Origin、无效 Bearer 即使携带缓存校验也拒绝。
- 错误使用 `{code,message}`：参数错误 HTTP 400 / 40001；认证、来源沿用 v2 规则。仅 GET，其他方法不支持。
- `GET /api/v1/auth/config` 和 `/api/v2/auth/config` 的 `data.market_calendar` 均指向固定 `/api/v2/market-calendar`，包含 `api_version:2`、`access:"public"`、schema/data 版本、市场、时区、交易所和 verified_years。


### auth/config 能力字段完整示例

以下 JSON 是 `data.market_calendar` 对象本身，两版 auth/config 使用同一对象，字段名与类型保持一致。`markets` 为数组；`schema_version` / `api_version` 为整数；`calendar_version` 为字符串；`verified_years` 为整数数组。

```json
{
  "path": "/api/v2/market-calendar",
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

## 响应

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

## 缓存与 iOS 使用

HTTP `Cache-Control: public, max-age=300, must-revalidate`，`ETag` 含 schemaVersion/calendarVersion/market/year，`Vary: Origin, Authorization`。发送 If-None-Match 可返回无正文304，保留缓存实体；请求参数、数据修订或 schema 变化必须区分缓存。错误不缓存。

缓存键至少包含站点 origin / API v2 / market / year；返回仅应用到仍匹配请求上下文的日历。iOS 自行使用原生模型，不导入 Web TypeScript 模块。每次仅展示所选市场，切换市场分别请求，不混合三市场安排；休市用所选市场图标、half_day 加金色圆点、unknown 显示紫色圆点及未确认。年切换及快速连点不能显示上一年的旧结果。

保持现有纽约时间20:00盈亏归档周期及业务规则。日历仅辅助识别计划休市，不改持仓、账本、盈亏计算或报价新鲜度判断；未知安排不自动触发业务写入。

## 核实范围与来源

首版覆盖 2026 年 SSE / SZSE 现货股票（A 股沪深，不含北交所）、SEHK 证券市场、NYSE / Nasdaq 常规现金股票交易。不覆盖期权、盘前盘后、个股停牌及临时停市。

- [上交所休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/)
- [深交所2026年安排](https://www.szse.cn/disclosure/notice/general/t20251222_618087.html)
- [HKEX 2026年安排](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf)
- [HKEX 证券交易时段](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market)
- [NYSE 交易假期](https://www.nyse.com/trade/hours-calendars)
- [Nasdaq 交易假期](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule)

2026 计划交易天数（含半日）：沪深242、港股247（半日3）、美股251（半日2）。美股7月2日正常，7月3日休市；民用调休补班周末不转成交易日。

后续年度须逐交易所核对后登记，并提高 calendarVersion；结构不兼容时提高 schemaVersion。首版只支持一个已核实年度，切换其他年份明确显示未知。

## Web 与 App 的市场选择

每次请求必须指定单个 `market=US`、`HK` 或 `CN`，响应中的 `data.market` 和全部 `days` 只属于该市场，不混入另一个市场的休市或半日市。切换市场需重新请求该市场年度数据；状态筛选由客户端依据 `days[].status` 完成，年度 API 保留完整日期网格。

Web 示例：`/global?section=calendar&market=HK&calYear=2026&calMonth=12&calStatus=half_day`。`calStatus` 为 `half_day` 或 `unknown`，不提供时显示该市场全部日期。再次点击当前状态取消筛选。刷新直接读取 URL，不先显示另一市场。
