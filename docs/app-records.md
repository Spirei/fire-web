# App 股票记录与 Web 同步合约

冻结修订 1（2026-10-03）。代码已实现；目标服务须实际发布 `records_contract.version = 1` 后才可开启安全提交。客户端以所选 v1/v2 的 discovery 为准，不探测写接口，不自动切版本或重放写入。

## 发现与授权

`GET /api/v{version}/auth/config` 的 `data.records_contract`：

```json
{
  "version": 1,
  "supported": true,
  "records_path": "/api/v2/records",
  "record_path": "/api/v2/records/{id}",
  "operation_path": "/api/v2/records/operations/{requestId}",
  "search_path": "/api/v2/search",
  "read_scope": "portfolio.read",
  "write_scope": "portfolio.write",
  "request_id_field": "requestId",
  "revision_field": "revision",
  "collection_revision_field": "collectionRevision",
  "idempotency": "reject-duplicate-query-original",
  "automatic_mutation_replay": false
}
```

v1 的四个路径对应 `/api/v1`。字段缺失或未知修订时，不宣称旧 POST/PUT/DELETE 有这些保证；不能仅向旧接口附加字段。旧连接已有 `portfolio.write` 即可写，无需按授权日期重新连接；只读连接继续只读，有效连接缺范围返回 40301，失效返回 401。新增权限使用所选版本的原生 permissions 流程，不用 Cookie 补足范围；默认登录范围不变。

## 读取与搜索

- `GET records?market=US&group=券商&page=1&pageSize=100`：`data` 是数组，`meta` 为 `{page,pageSize,total,collectionRevision}`；默认 20、最多 100。新增 `revision` 为正整数；其他字段仍为 `id,name,code,market,price,cost,qty,group,watchGroupId,watchGroupSort,note,source?,updatedAt`。数值仍为 number 或空字符串 `""`，不是总用 null。
- `GET records/{id}`：`data` 是单条记录，`meta.collectionRevision` 是读取时账户集合版本；跨账户和不存在统一 40401。
- 每页是一次原子快照。下一页可携带首个 `collectionRevision`；期间集合变化返回 40902，应丢弃旧分页并从第一页重新只读加载。不要合并不同版本的分页。
- `GET search?q=名称或代码` 已存在，返回 `data.results`，每项为 `{symbol,code,name,market,price,changePct,type?}`。搜索不创建证券目录。

所有 records 读取与 Web 同一账户、同一数据库；App 新增的是用户自选/持仓记录，不是全局证券目录。`group` 是券商，不是自选组。`watchGroupId` 可选，仅允许自己已有的自定义组，`""` 为不分组；省略更新时保留旧归属。市场内置组按 market 自动归属。qty 空或 0 是自选，正数是持仓；本接口保存快照，不生成成交订单或资金流水。

## 安全提交

POST records 的 JSON 包含 `requestId`（小写 UUID）及完整记录输入：`name,code,market,price,cost,qty,group,note,source?`，可选 `watchGroupId`。数值接受有限 number、null 或 `""`；price/qty 非负，cost 可为负；name 1–100 字、code 1–40 个字母数字/点/下划线/横线、market 1–40 字、group ≤100、note ≤500、source ≤50。不接受超长截断或错误数值变为空。

PUT records/{id} 使用相同完整输入，另加从读取得到的 `revision` 和新 `requestId`。不是 PATCH。

DELETE records/{id} 使用 JSON `{ "requestId": "小写 UUID", "revision": 记录版本 }`。

成功保持旧信封：POST/PUT 的 `data` 是已保存记录；DELETE 的 `data` 是 `{deleted:true,id,revision}`。安全提交额外返回 `meta`：

```json
{ "requestId":"小写 UUID", "kind":"create", "recordId":"r-…", "revision":1, "collectionRevision":1 }
```

kind 为 create/update/delete。删除 revision 是删除前版本。仅 HTTP 成功且 code=0，并核对 meta 的 requestId、kind、recordId、revision，才可确认保存。requestId 按账户隔离，同账户跨 v1/v2 共用；同键重复返回 40901，绝不再次写入；即使修改了载荷也不能复用旧键。

记录版本改变时 PUT/DELETE 返回 40902，不覆盖已有内容；不存在返回 40401。有任何成交历史的记录不可通过此接口删除（40903），不丢弃订单历史。先只读刷新最新记录，用户审阅后产生新 requestId 和 revision 提交，禁止自动覆盖。数据库事务同时提交记录、活动日志、集合版本和操作回执。

旧请求不带 requestId/revision 仍按原有字段和响应使用。只带 revision 时启用版本检查；带 requestId 的 PUT/DELETE 必须带 revision。旧 Web/App 写入、分组变化、订单更新和导入都推进记录版本；删除再导入同 ID 不恢复旧 revision。

## 未确认结果

`GET records/operations/{requestId}` 只读，需 portfolio.read。200/code=0 的 data 为：

```json
{
  "requestId":"小写 UUID", "kind":"create", "recordId":"r-…",
  "state":"completed", "code":0, "message":"ok",
  "record":{}, "deleted":false, "revision":1, "collectionRevision":1,
  "createdAt":"ISO 8601", "completedAt":"ISO 8601"
}
```

record 是提交时确认快照，不是此刻最新记录；删除时为 null。业务拒绝的 state=failed，嵌套 code/message 是失败原因；失败 revision 可为 null。查询成功不能当成写成功。非法字段、鉴权失败、未提交的内部事务失败不会建立回执。

网络断开/超时/500 时仅查操作结果。404 仅表示此刻未找到已提交回执，可能原请求还在接收，不能推断“没有写入”，也不能自动再发 POST/PUT/DELETE。失败回执或完成回执持久保留到账号删除；无需轮询写请求。查询之后还应读取最新 records/overview；不拿历史回执覆盖当前较新的记录。

## Web 刷新

进入持仓、自选、资产分析、盈亏分析、FIRE 或财报页，以及这些页面回前台/浏览器恢复时，合并读取当前账户 records。后台、离页、退出/换账户取消读取；迟到响应不能覆盖本地新写入或另一账户状态。行情覆盖与记录保存分别处理，不用行情刷新冒充跨端记录同步。

## 发布与验收

只在临时数据库与模拟客户端测试并发、重复键、跨用户、撤销、事务回滚、订单/分组/导入版本变化及 Web 前台读取。本轮不写真实用户持仓，不部署；push 与服务已上线是两个状态。客户端等目标服务器 discovery 实际出现上述修订后再开启安全写入。
