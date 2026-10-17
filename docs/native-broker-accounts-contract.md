# 个人券商账户 v1（2026-10-17，字段冻结；已实现待集成，尚未部署）

本文件供并行接线，服务端源码已实现并验证，不表示线上服务器已支持。cd7c922 登录修复的发布不含本功能。只维护本人记账账户，不连接真实券商、不索取凭据，不承诺券商数量或导入能力。

## 能力发现与权限

同源所选 `/api/v1/auth/config` 或 `/api/v2/auth/config` 的 data 新增可选 `broker_accounts`：

```json
{
  "version": 1,
  "presets_path": "/api/v2/broker-accounts/presets",
  "accounts_path": "/api/v2/broker-accounts",
  "account_path": "/api/v2/broker-accounts/{accountId}",
  "icon_path": "/api/v2/broker-accounts/{accountId}/icon",
  "operation_path": "/api/v2/broker-accounts/operations/{requestId}",
  "read_scope": "portfolio.read",
  "write_scope": "portfolio.write",
  "request_id_field": "requestId",
  "revision_field": "revision",
  "automatic_mutation_replay": false,
  "icon_upload": {
    "content_types": [
      "image/png",
      "image/jpeg",
      "image/webp"
    ],
    "max_bytes": 2097152,
    "max_dimension": 4096,
    "max_pixels": 16777216
  },
  "record_binding_id_field": "brokerAccountId",
  "binding_path": "/api/v2/broker-accounts/{accountId}/bindings",
  "statements": {
    "connectors": [
      {
        "id": "ibkr-flex",
        "providerId": "ibkr",
        "label": "IBKR · Flex官方账单",
        "helpUrl": "https://www.ibkrguides.com/advisorportal/ug/flex3.htm",
        "accept": ".xml,application/xml,text/xml",
        "fileLabel": "Activity Flex XML",
        "maxBytes": 8388608,
        "externalAccountLabel": "官方账户编号",
        "fields": [
          {
            "key": "externalAccount",
            "label": "官方账户编号",
            "secret": false
          },
          {
            "key": "queryId",
            "label": "Flex Query ID",
            "secret": false
          },
          {
            "key": "token",
            "label": "Flex Token",
            "secret": true
          }
        ]
      }
    ],
    "connection_path": "/api/v2/broker-accounts/{accountId}/connection",
    "preview_path": "/api/v2/broker-accounts/{accountId}/statements/preview",
    "fetch_path": "/api/v2/broker-accounts/{accountId}/statements/fetch",
    "apply_path": "/api/v2/broker-accounts/{accountId}/statements/apply",
    "max_bytes": 8388608,
    "preview_required": true,
    "automatic_apply": false
  },
  "record_binding": "owner_record_group_exact_account_name",
  "delete_referenced_account": "reject"
}
```

v1全部路径使用`/api/v1`。只有version=1及固定同源路径/字段验证通过，且当前真实grant包含读写scope时才开放写操作。没有能力/离线只显示离线预设，不可显示保存成功。Bearer-only；不借Cookie补权限，App管理员身份不继承Web管理权限。Web若接入使用本人会话和同源校验，权限不扩展到全局共享目录。

## 公共机构目录与个人账户分离

GET presets_path -> `{code:0,message:"ok",data:{items:[Preset]}}`。
Preset：`{id,name,aliases:string[],defaultCurrency,icon:string|null}`。icon优先为同源Web素材库真实已有图标，再回退随镜像提供的12个官方App图标 `/broker-presets/{id}.jpg`（来源及SHA见broker-icon-sources.json），实际文件不存在时返回null，不编造URL。iOS按id使用自带图标离线兜底。
稳定ID共12项：longbridge, ibkr, futu, tiger, trading212, moomoo, robinhood, huatai, schwab, usmart, eastmoney, ths。盈立=usmart、盈透=ibkr、嘉信=schwab；同花顺/东方财富仅记账机构标识。机构目录只读，预设图标可由Web管理员素材库维护，个人上传不能污染目录。
旧GET/POST/DELETE `/brokers` 保持共享目录和管理员权限。为避免字符串绑定歧义，共享目录新名称/别名也不能与已存在的个人账户重名（409）；共享改名/删除钩子不修改个人账户已绑定的本人记录。不得把个人账户写到site_settings.groups，也不能放开旧/brokers写权限。

## 账户读取

GET accounts_path -> `{code:0,message:"ok",data:{accountId:"当前用户ID",items:[Account],collectionRevision:0}}`。
GET account_path -> `{code:0,message:"ok",data:Account}`。
Account固定字段：

```json
{"id":"ba-opaque","name":"我的盈透","providerId":"ibkr","currency":"USD","revision":1,"icon":null,"iconSource":"preset","recordGroup":"我的盈透","recordCount":0,"createdAt":"ISO8601 UTC","updatedAt":"ISO8601 UTC"}
```

providerId为上述ID或null（自定义）；currency为服务端FUND_CURRENCIES支持的三位ISO币种。name去首尾空白，1–60字符，禁止控制字符。本人账户名大小写不敏感唯一，并与当前共享券商名称/别名区分（例如“我的盈透”）；不同用户隔离。recordGroup严格等于保留大小写的name。icon为真实可读取的同源路径或null；iconSource只为custom/preset/none，预设图标缺失时preset仍允许iOS按providerId离线兜底。自定义上传优先于preset。

个人列表绑定账号/授权/所选API版本和缓存代次；切换或撤权时清除，不能将旧异步响应写入新账户。collectionRevision为本人账户集合递增版本；具体修改仍核对account.revision。

## 与持仓、交易及资产的关联

现有records的group、broker展示/选择继续沿用字符串。编辑器把旧/brokers共享选项与本人账户选项分别读取；选中个人账户时写入该Account.recordGroup到现有records安全提交接口，沿records的requestId及recordRevision/CAS，不另造一份持仓或交易。
服务端本人records.group精确等于本人Account.name时归属于该账户；账户列表recordCount为本人精确匹配数量。创建账户时若该名字已经存在本人records.group，返回40902，不能默默认领旧记录；用户可选不冲突名称，再通过现有记录编辑明确归属。不批量认领/迁移旧全局共享数据，不修改他人记录。
账户改名必须同时提供当前records集合collectionRevision（字段名recordCollectionRevision）；同一事务内核对版本、仅更新本人精确匹配旧recordGroup的记录，沿既有records更新机制递增版本。改名后的Account.recordGroup同步更新；原record ID、持仓数量/价格/成本、交易ID、资金、证券声明和真实订单不变。无记录绑定时改名仍须核对recordCollectionRevision，避免并发新增绑定漏更新。目标名字若已被本人其他账户或本人其他group记录使用则冲突。
资产配置本人brokers选项合并个人账户（id=Account.id）；其证券节点使用稳定 `broker:{Account.id}:{证券结算币种}`，改名不改变节点ID或已有核对记录，assign沿已有CAS仅选本人账户。旧GET/brokers仍只返回共享目录；客户端不得把个人账户保存回共享目录。
account-assets继续读取同一records和真实账本。不会新建持仓、重复计资产或新建资金。客户端按本人Account.recordGroup关联rawRecord.group即可，无须假设新增brokerAccountId字段。旧/brokers名称和全局分类仍存在；个人列表不是替代全局目录的写接口。
删除账户时若存在本人引用记录（包括零持仓/自选）返回40902。先通过正常records编辑明确迁移或取消引用，再重新确认删除；不自动清空券商或删除订单/资金。图标更新不改记录group或版本。

## 创建/编辑/删除与回执

POST accounts_path JSON：`{requestId:"小写UUID",name,providerId:null|预设ID,currency}`。严格拒绝未知字段。成功创建revision=1。本人最多100个账户；超限40902。
PUT account_path JSON：`{requestId,revision,name,currency,recordCollectionRevision}`。providerId创建后不可修改；更换机构须另建账户。currency只是账户默认记账货币，不转换或改写任何已有记录/资金；已有持仓币种仍按证券市场/真实来源核算。
DELETE account_path JSON：`{requestId,revision}`。
每次新的用户确认使用新requestId。成功 HTTP200（创建201）信封data为Operation：
`{requestId,kind:"create"|"update"|"delete"|"upload_icon"|"reset_icon",accountId,state:"completed"|"failed",code:0,message:"ok",completedAt:"ISO8601 UTC",data:Account|null}`。
写入与成功回执同一事务；删除data=null。创建在分配账户ID之前遇到名称/限额业务冲突时，failed回执固定为kind=create、accountId=""、data=null；仅此组合允许空ID，表示没有创建账户。创建成功以及所有其他kind必须有对应真实ba-账户ID；失败创建不能视为本地保存成功。有效已授权命令的业务冲突以failed回执保存；输入/权限/来源不合法未执行，不创建业务回执。版本冲突HTTP409/code40902；重复requestId HTTP409/code40901，查询原回执，不重放命令。
GET operation_path返回当前用户本人Operation，跨用户/不存在40401。超时、离线、进后台不自动重放，先查询；404也不是自动重提授权。需要用户重新确认时生成新UUID并重读版本。
所有私有JSON及图标响应no-store/private。成功不得依赖客户端本地虚构账户；必须使用真实返回的id/revision/icon。

## 图标上传/重置/读取

POST icon_path：multipart字段严格为requestId（UUID）、revision（十进制字符串）、file（单个图片）。每个预设和自定义账户均允许上传/再次更新，CAS采用当前账户revision，成功递增并返回upload_icon回执中的最新Account。私有图标缓存键必须包含授权/账号/Account.id及revision，成功上传或重置后清除旧缓存。
支持PNG/JPEG/WebP；按真实文件头及解码结果校验，不仅依赖扩展名或Content-Type；单文件<=2MiB、宽高各<=4096、总像素<=16777216，拒绝动画、多帧、SVG、外部资源及畸形数据。服务端规范化为不含元数据的单帧PNG，缩至最大512px；限制multipart总字节防止内存滥用。
GET icon_path读取本人custom图标，未上传40401；不允许匿名或其他用户，Bearer要求portfolio.read，站点本人会话同源规则沿已有认证。不使用公开/uploads路径、不透露磁盘绝对路径。Account.icon在custom时为同源icon_path；APIClient以当前授权请求图片，不能让匿名AsyncImage直读。图标读取鉴权通过后返回image/png及no-store/private、nosniff。
DELETE icon_path JSON `{requestId,revision}`，返回reset_icon回执；清除本人覆盖，恢复当前真实预设icon或null（自定义账户为none/null）。绝不删除共享预设图标。规范化图片以私有SQLite BLOB保存，随账户、revision及回执同一事务替换；失败回滚保留旧图，不产生公开附件或孤立文件。成功替换/重置即回收旧BLOB，不冒充保存成功。

## 错误/范围

401失效授权、403缺scope/来源、404本人资源不存在、40901重复请求、40902版本/名称/引用冲突、40001参数/图片不合法、413文件/请求超限、50001存储失败。一般错误信封`{code,message}`；已保存failed回执可经operation查询。无用户枚举或跨账号资源查询。
部署前必须临时库/私有文件回归：双版本、只读/读写授权、Cookie不能提升、跨用户隔离、改名记录版本与回滚、旧共享目录不变、CAS/重复/超时原回执、图标真实性/尺寸/字节/动画限制、上传失败旧图保留、恢复默认与引用删除拒绝。
