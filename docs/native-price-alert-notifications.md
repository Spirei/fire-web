# 股价提醒通知接入 · 2026-10-21

原生 0.2.364，服务端 v0.1.63。用户确认微信暂缓，接入 App 内、邮件、Telegram。

## 发布及配置

本次只修改源代码、临时数据库验证与正常 App 模拟器构建；未部署服务端、未发送真实通知、未推送手机。按项目既定流程手动发布 Web 服务。长期运行 Node 实例通过 instrumentation 每5秒启动一轮监控，SQLite租约隔离多实例；不适用于仅按请求唤醒的无常驻服务平台。

- `ALCOR_PRICE_ALERTS_ENABLED=false` 可停止监控与修改。默认启用，旧本机草稿不自动上传。
- App 内：真实事件持久化到本人收件箱，前台铃铛轮询；不包含 APNs 锁屏推送。
- 邮件：复用现有 SMTP/TLS 和邮件额度，仅向本人已验证邮箱发送；沿原账户邮箱验证流程配置，不接受任意收件人。
- Telegram：服务器配置 `ALCOR_TELEGRAM_BOT_TOKEN`、`ALCOR_TELEGRAM_BOT_USERNAME`，使用独立机器人；worker通过官方getUpdates轮询，不应与其他消费者或现有webhook混用。密钥只在服务器环境中配置。App获取5分钟一次性深链，在机器人私聊发送start后回App确认显示的账号，再开启通道。聊天ID加密保存，绑定令牌只存hash，拒绝群组、过期与重复使用。

## 合同与行为

`auth/config` 的 `price_alerts` 显式发现 v1协议及v1/v2规范路径。GET `price-alerts` 返回本人accountId、集合版本、规则、通道状态、最近200事件和未读数。POST `price-alerts/operations/{UUID}` 执行规则upsert/delete/state、channel、read、test或Telegram确认/解除；GET同路径只查询原回执，重复POST返回409，不自动重放。POST `price-alerts/telegram-link` 获取一次性私聊深链。所有路径沿原App授权，读取portfolio.read、修改portfolio.write；写前重新核对当前授权。

规则使用Decimal字符串最多6位小数、本人规则版本CAS、真实市场币种，港股HKD；美股默认全时段。监控仅消费行情池新鲜非缓存报价，核对来源、原行情时间≤90秒、真实交易时段、激活时间和授权存活，不更改订单、资产、费用或现金。仅一次触发后完成；每天一次按市场交易日去重。真实记录保存PRE/REGULAR/AFTER/OVERNIGHT及行情时间。

事件、一次触发完成状态及发送队列在同一事务保存。SMTP/Telegram返回接受回执显示accepted；不冒充已读或最终送达。发送前再检查授权、规则版本与通道；超时、崩溃后不重发，unknown保留供核对。手动测试仅在用户点击时入队，文字明确为测试。App内事件为delivered。已启用绿色圆点仅来自服务器监控状态，本机草稿仍待启用。

原生检查accountId、源/授权/私有缓存代次、版本与快照顺序；迟到响应不覆盖新状态。规则保存在服务端，旧本机草稿只有用户显式保存才上传；服务端未公布能力时仍为本机草稿及待接入，不伪造绑定或发送。

## 验证

`node tests/price-alerts.cjs` 使用临时SQLite、独立授权及拦截SMTP/Telegram：本人隔离、读写权限、CAS、原UUID回执、6位Decimal、新鲜报价、时段、每天去重、撤销/到期、验证邮箱、Telegram一次性私聊与显式确认、接受回执及未知结果不重发。不使用真实账户，不发送真实消息。正常App构建及模拟器UI另行记录。

## 线上缺口核对（2026-10-21）

线上健康检查为v0.1.62 / 97dd2032b569b827dc2167a23bf2812a7d5cfd78，v1 auth/config没有price_alerts，v2/price-alerts返回404。用户API授权正常不等于旧镜像已提供提醒；v0.1.63须按项目流程发布镜像并更新群晖，之后核对两个版本发现合同及未授权401（不再404），再由本人App显式启用原草稿。不自动上传/启用存量规则，不发送验证消息。

## 股价提醒邮件模板

设置的邮件模板列表包含price_alert（股价提醒），支持编辑、恢复默认及无发送的手机/桌面预览。变量包括stockName、stockCode、market、currentPrice、targetPrice、currency、direction、session、quoteTime、triggerTime，以及原公共变量。实际触发邮件读取保存模板、嵌入同一品牌图片，只发送本人验证邮箱；主动测试使用明确的邮件服务测试模板，不伪造成价格触发。旧五个模板的自定义保留，新的股价模板默认中性灰阶。
