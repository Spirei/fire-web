# 原生个人主页账户同步 v1（2026-10-18）

面向iOS原生，服务端实现未代表生产已发布。App先发现能力，旧服务不上传/不自动清空本机资料；离线保留原内容，iCloud仍作备份恢复，不作为账户实时同步。

## 能力与身份

`GET /api/v{1|2}/auth/config` 中 `data.personal_profile`：

```json
{"version":1,"path":"/api/v2/personal-profile","background_path":"/api/v2/personal-profile/background","operation_path":"/api/v2/personal-profile/operations/{requestId}","read_scope":"portfolio.read","write_scope":"profile.write","bio_max_graphemes":160,"background":{"content_types":["image/jpeg"],"max_bytes":8388608,"max_dimension":2048},"patch_only":true,"automatic_mutation_replay":false}
```

v1路径同构。仅同源App Bearer，Cookie不补权限；读portfolio.read、写profile.write，不自动扩grant。保留原auth/profile头像昵称及安全字段。

GET path（不产生资料行、不初始化、不清空）：

```json
{"code":0,"message":"ok","data":{"userId":"user-stable-id","revision":0,"bio":"","gender":"unspecified","background":null,"initializedFields":[]}}
```

`gender`只能unspecified/male/female。简介最多160个扩展字素簇（Intl.Segmenter，与Swift Character语义兼容；极新Unicode版本差异服务端校验为准）。
background有图时为`{path:"/api/v2/personal-profile/background",sha256:"64位小写十六进制"}`；哈希针对服务端去元数据后实际存储的JPEG字节。相对路径固定本人身份，不是公开地址。
initializedFields是bio/gender/background子集，区分从未设置与明确清空；revision为全资料版本，新资料0。

## PATCH明确字段

```json
{"requestId":"12345678-1234-4234-8234-123456789abc","revision":0,"changes":{"bio":"个人简介","gender":"female"}}
```

changes至少一个字段，禁止未知字段；省略字段保持，空bio是明确清空、gender:unspecified是明确选择。
背景删除用`changes:{background:null}`；非空图须上传接口。使用服务端revision CAS，冲突40902，必须保留本机草稿并重新读取，不整份覆盖、不猜revision加一。

## 背景上传和读取

POST background_path multipart：file（JPEG，真实解码，单帧，最长边≤2048，≤8MiB）、requestId、revision、可选migration（字符串true/false）。服务端重新编码JPEG去元数据；失败保留旧图。不要把Token、图片或完整用户数据写日志/URL。
GET background_path使用同Bearer，私有no-store image/jpeg/nosniff；无图404、无身份401、缺权限403。不接受userId参数，不能读取他人图片。App缓存以服务来源/userId/sha256隔离；退出/换授权/取消后不把旧异步结果写入当前账户，下载失败保留已验证的原图。

## 一次写入回执

PATCH成功kind:update_profile，上传成功kind:upload_background；统一响应：

```json
{"code":0,"message":"ok","data":{"requestId":"12345678-1234-4234-8234-123456789abc","kind":"update_profile","userId":"user-stable-id","state":"completed","code":0,"message":"ok","completedAt":"2026-10-18T05:00:00.000Z","data":{"userId":"user-stable-id","revision":1,"bio":"个人简介","gender":"female","background":null,"initializedFields":["bio","gender"]}}}
```

每个requestId同用户唯一，跨v1/v2同回执。重复40901，GET operation_path查原；业务CAS/迁移冲突保存failed回执（data:null，code40902）。认证、格式、图片解码、限流等前置拒绝无回执。读取旧回执是历史结果，不作为最新远端覆盖新快照。
超时/断网未知结果保留固定requestId，先GET原回执；404不代表可重传，不自动换ID、不自动重复上传，继续读取资料及hash核实。取消HTTP不保证服务器未提交，同样先查原操作。每次params/body/image异步等待后及事务提交前重新校验同grant/user/security stamp。
单用户写入每分钟30次，429不得立即自动重传。

## 旧本机资料迁移

先GET远端，不因空新设备而PATCH空值。只有本机实际存在的旧字段才参与导入。
对所有拟导入字段，远端initializedFields均未包含时，可用当前revision＋migration:true提交；上传同样传migration:true。服务器原子检查，另一设备先写任一该字段会40902/failed回执，保留本机副本，由用户明确选择解决。
远端明确清空也是initialized，禁止本机备份自动复活。简介/性别与图片可分别提交，但每次成功必须重新读取远端revision及initialized再决定下一项。远端已有字段可在客户端排除，仅迁移剩余未初始化字段；不自动覆盖冲突字段。
用户主动决定覆盖时才发普通PATCH/上传（migration省略/false），仍须最新revision。
