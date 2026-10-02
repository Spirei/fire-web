# App 安装包中心

沿用 fire-web 镜像、域名及管理员 Cookie，不需要单独运行原 Python 服务。

- 页面：`/alcor-test`（仅现有 Web 管理员可访问）。
- 列表：`GET /api/app-packages` 仅管理员可读，返回 `{packages, maxBytes, canUpload}`。
- 上传：`POST /api/app-packages`，原始二进制请求体，`X-File-Name` 为 encodeURIComponent 文件名，Content-Length 为实际字节数，Content-Type 为 application/octet-stream。需要 Web 管理员身份；App bearer 不具备管理员权限。浏览器必须同源。
- 响应：201 `{id,name,size,platform,createdAt}`；401 未登录、403 非管理员、413 超限、429 限流、400 文件不完整/保存失败。
- 下载：`GET /api/app-packages/download/{id}`，需要有效 Web 管理员登录，匿名及普通用户返回 403；App bearer 不具备管理员权限。
- 安装包落盘：`data/app-packages/files/{id}`，复用现有私有 data 卷，不放 public 目录。
- 登记信息：`data/app-packages/{id}.json`，复用 data 卷；临时文件位于同目录，上传失败清理。

单包最大 2 GB，APK/IPA 扩展名及 ZIP 文件头校验。此入口不验证 Bundle ID、签名、设备注册、证书到期，也不生成 iOS OTA manifest；不会把普通 ZIP 或未签名 IPA 标记为可安装。现有 iOS 发布脚本仍管理 `/uploads/alcor-test/releases/` 和安装清单，独立于本上传目录；不要重复写同一个 index.html。

内部入口（域名可达，但必须管理员鉴权）：`https://fire.6dm.tv:18520/alcor-test`，必须发布包含本次代码的 fire-web 镜像后验收。部署前访问 404 属于旧镜像行为。Lucky 需允许安装包请求大小与持续上传时间。

代码更新后按既有 GHCR 工作流发布镜像，再在服务器更新 fire 容器。核实实际域名 HTML、列表、上传权限和下载响应，以及匿名/普通用户无法访问页面、接口与 `/uploads/alcor-test` 直接文件链接，不能以磁盘文件存在作为上线证明。无包时显示真实空态。

`/uploads` 文件读取先经过动态鉴权再访问磁盘，`alcor-test` 全目录仅管理员可读，响应 private/no-store。外网用户无法匿名访问内部安装包。
