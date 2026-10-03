# App 个人资源库：冻结合约 1

冻结日期：2026-10-03。本文件为 iOS 接入依据。v1/v2 共用个人服务；不调用管理员附件、公开头像、助手会话附件或安装包中心。

状态：合约已冻结，服务端已实现并通过临时数据库与磁盘 fixture 验证，尚未部署。线上仅在 `GET /api/v{selectedVersion}/auth/config` 出现 `resource_library.supported=true` 且 `contract_version=1` 时可启用；字段缺失表示服务器不支持。App 保留已经选择的业务 API 版本。

## 授权与 discovery

默认登录仍为 `portfolio.read portfolio.write`。资源库另行明确授权 `resources.read`（列表、元数据、下载、结果查询）和 `resources.write`（上传、创建/删除空文件夹、删除文件）；write 必须同时有 read。既有权限升级/密码及二次验证流程签发新连接，保存成功后再撤销旧连接，不扩大基础登录。

每个请求仅接受原生 App Bearer，Cookie 不补充权限；缺 scope 返回 HTTP 403 / code 40301，失效连接 401；他人 ID 返回 404。下载也不能把 access token 写入 URL。

```json
{
  "resource_library": {
    "supported": true,
    "contract_version": 1,
    "path": "/api/v2/resource-library",
    "read_scope": "resources.read",
    "write_scope": "resources.write",
    "categories": [
      {"id":"components","name":"构建"},
      {"id":"media","name":"影音内容"}
    ],
    "received_files_path": "/api/v2/resource-library/files",
    "file_sorts": ["name","createdAt"],
    "sort_directions": ["asc","desc"],
    "file_kinds": ["image","video","audio","document","archive","other"],
    "recognized_extensions": {
      "image":["jpg","jpeg","png","gif","webp","heic","heif"],
      "video":["mp4","mov","webm"],
      "audio":["mp3","m4a","aac","wav","ogg","flac"],
      "document":["pdf","txt","md","csv","json","docx","xlsx","pptx"],
      "archive":["zip","gz","7z","rar"]
    },
    "max_upload_bytes": 52428800,
    "quota_bytes": 1073741824,
    "page_size": 30,
    "max_page_size": 100,
    "max_folders": 128,
    "max_folder_depth": 8,
    "max_files": 5000,
    "upload_format": "multipart/form-data",
    "download_auth": "bearer",
    "range_supported": true,
    "automatic_mutation_replay": false
  }
}
```

v1 discovery 的 path 和 received_files_path 分别为 `/api/v1/resource-library` 和 `/api/v1/resource-library/files`，其余相同。分类稳定 ID 与显示名分离；接收文件是浏览 components/media 的统一入口，六类在服务端筛选后分页，不另建 received 存储分类。目录和原文件均只属于当前用户，没有业务目录枚举功能。

## 路径（相对 discovery.path）

| 方法 | 路径 | 输入 / 返回 |
| --- | --- | --- |
| GET | 根路径 | discovery 合约及 `usage` |
| GET | `/folders?category=components&parentId=…&limit=30&cursor=…` | 当前层 `{items,nextCursor}`；省略 parentId 为分类根 |
| POST | `/folders` | JSON `{category,parentId?:string,name}`；返回 Folder |
| DELETE | `/folders/{folderId}` | JSON `{revision}`；只允许空目录，返回 `{deletedId}` |
| GET | `/files?kind=image&folderId=…&sort=name&direction=asc&limit=30&cursor=…` | `{items,nextCursor,usage}`；省略 category 为两个分类的汇总；省略 folderId 为所选分类内所有文件；`folderId=root` 为根目录；kind 可用于所有分类 |
| POST | `/files` | multipart 单个 file、category、可选 folderId、requestId；返回 File |
| GET | `/files/{fileId}` | File 元数据 |
| GET | `/files/{fileId}/content` | 私有二进制，支持单一 bytes Range |
| DELETE | `/files/{fileId}` | JSON `{revision,requestId}`；返回删除回执 |
| GET | `/uploads/{requestId}` | 上传 Operation |
| GET | `/deletions/{requestId}` | 删除 Operation |

JSON 沿用 `{code:0,message:"ok",data:…}`。错误 HTTP 400/401/403/404/409/413/415/429/500，业务 code 为 HTTP 状态 × 100 + 1。POST 成功 HTTP 201，其他成功 200；Range 成功 206，越界或多个 Range 为 416。所有资源响应私有且 no-store。

requestId 为 App 在用户确认一次上传/删除时新建的**小写 UUID**。同一用户 requestId 在上传/删除间共用命名空间；重复写请求返回 409，不重复上传或删除。App 不自动重放写入；遇超时/断线先 GET 对应结果。404 仅表示没有已登记的操作，不能证明一个仍在传输的请求不会继续执行，等待原请求停止并由用户决定。500 或 pending 不能当成成功。失败后用户主动重试使用新 requestId；删除仍校验原 revision。

## 字段

```ts
type Category = "components" | "media";
type FileKind = "image" | "video" | "audio" | "document" | "archive" | "other";
type Folder = { id:string; category:Category; parentId:string|null;
  name:string; revision:number; createdAt:string };
type File = { id:string; category:Category; folderId:string|null; name:string;
  kind:FileKind; mime:string; sizeBytes:number; sha256:string; revision:number;
  createdAt:string; state:"ready"|"deleting"; downloadPath:string };
type Usage = { usedBytes:number; quotaBytes:number; fileCount:number };
type Operation = { requestId:string; state:"pending"|"completed"|"failed";
  fileId:string; result:File|DeletionReceipt|null };
type DeletionReceipt = { deletedId:string; fileDeleted:true; removedBytes:number;
  usedBytes:number; deletedAt:string };
```

所有日期 UTC ISO 8601，字节数为 JSON 安全整数，sha256 为 64 位小写 hex。folder/file ID 分别为 `rld_`/`rlf_` + 32 位 hex。downloadPath 是所选 API 版本的相对路径，没有公开 URL、宿主路径和用户目录路径。删除回执持久保存；查询同一操作得到同一回执，usedBytes 是删除完成时的账户用量快照。

分页使用不透明 cursor，默认 30、最大 100，支持 `sort=name|createdAt`、`direction=asc|desc`，默认 createdAt/desc，名称按 Unicode 二进制顺序；同值按 ID 同向排序；游标绑定当前用户、分类、筛选和排序条件，不可跨用户/筛选使用。目录名和文件显示名最长 120 个 Unicode 字符且 UTF-8 不超过 240 字节，不允许路径分隔符、控制符、`.` 或 `..`；同层同名目录冲突，文件允许同名，ID 独立。目录深度最多 8，每用户最多 128 个目录、5000 个未删除文件。

## 文件、限额与存储

- 每次仅上传一个非空文件，最大 50 MiB；整个 multipart 上限为文件上限 + 64 KiB。每个账户总容量 1 GiB，待写入/删除失败但仍在磁盘上的文件占用额度。限额服务端强制执行，返回真实账户用量。
- 图片 JPEG/PNG/GIF/WebP/HEIC/HEIF；视频 MP4/MOV/WebM；音频 MP3/M4A/AAC/WAV/OGG/FLAC；文档 PDF/TXT/MD/CSV/JSON/DOCX/XLSX/PPTX；压缩包 ZIP/GZIP/7Z/RAR。按后缀与文件头识别并校验常见格式，文本验证 UTF-8；不信任客户端 mime。未列类型为 other，mime 固定 application/octet-stream，仅原样存储/私有下载。discovery 会列出实际识别的后缀。
- components 接受上述类型及 other；media 只接受 image/video/audio。图片导入不强制转换，HEIC 可原样存储；客户端根据本机能力预览。首期没有服务器转码、缩略图、压缩包解包、分片上传或断点续传。
- 原件存于持久化 data 卷内 `resource-library/<用户ID的SHA256>/`；元数据位于独立 owner-scoped SQLite 表。数据库和 data 卷必须共同备份；现有数据库/公开素材备份不包含此私有目录，上线需纳入 NAS data 卷备份。不复用 public/uploads、管理员附件和系统业务目录。
- 上传采用服务端随机文件名及临时文件，写入校验后登记 ready；失败清理临时文件和未成功原件。进程中断后通过操作查询核对原件与登记，不自动重新上传。
- 删除先登记操作，再实际 unlink 原件，再落删除回执；没有回收站。删除失败仍占额度，不返回成功；已有管理员删除账户流程同步移除该账户原件及资源元数据；若进程在 unlink 后中断，查询根据原件确已不存在补记同一回执，不自动再次删除。removedBytes 是本服务移除的原件字节数，不声称 NAS 快照也已释放。
- 私有下载强制 Bearer、nosniff、sandbox、attachment。影音播放器无法附带请求头时，App 用授权请求先下载到本机临时文件再播放；不得退回 Cookie/公开链接。撤销授权后发起的新请求拒绝，已经开始传输的响应不承诺中途撤回。

## 上线条件

本轮不自动部署。需要包含本实现的容器版本、可写且持久化的 data 卷、反向代理允许至少 50 MiB + 64 KiB 请求体及足够上传超时。每个服务进程最多同时解析两个上传，超额返回 429；50 MiB 是文件上限，不意味着 iOS 本轮已经验证所有视频编码或真实大文件网络导入。
