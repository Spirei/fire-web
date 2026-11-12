# Fire 部署

Fire 的网页、App 接入和后台管理使用同一份源码与镜像。内置后端通过私有 Unix socket 接入，不另设 AlcorApi 站点。当前使用 PostgreSQL；未来可按实际需求重新评估数据库。SQLite、存储切换和旧同步 PG 桥接已退出。

## 切换前

核对实际数据库、实例 ID、迁移版本、完整备份和原件目录，并准备可验证的恢复方案。现有数据库与文件不会由新版启动命令自动导入、初始化、迁移或删除。数据库不匹配时停止启动，不能通过新建空库或回退存储继续运行。

此份源码目前提供迁移候选实现；通过本地测试、发布镜像、替换容器与线上验收是不同步骤。接口迁移清单中的后端登记状态也不代表页面或 App 已验收。

## 配置

参考根目录 `.env.example`，在部署环境保存真实配置，禁止提交到仓库。

PG 和 Redis 连接只接受服务器环境配置。系统总览展示当前脱敏连接并允许测试，不能在线保存另一份地址或密码；旧连接配置、加密启动覆盖文件不会覆盖 `.env`，也不会被源码更新删除。修改连接后重新创建容器或重启对应本地服务生效。业务数据、日常偏好和任务回执仍在 PG。

- `FIRE_PUBLIC_ORIGIN`：用户实际访问的完整地址，包含非标准端口。
- `FIRE_DATABASE_URL`、`FIRE_INSTANCE_ID`：已核实的当前数据库及实例身份。
- `FIRE_REDIS_URL`：可选缓存连接；缺少缓存配置不会显示假连接状态。
- `FIRE_CONNECTION_SECRET_DIR`、`FIRE_BACKUP_DIR`、`FIRE_BACKUP_SECRET_DIR`、`FIRE_FILE_ROOT`、`FIRE_ASSET_ROOT`：分别设置在私有挂载目录下，保持秘密、备份和文件的边界。目录须允许容器用户 1000 访问。
- `FIRE_WORKER=on`：启用独立后台任务进程；关闭时任务保持排队，不伪造心跳。
- `FIRE_PRIVATE_DIR`：私有数据的宿主机目录，挂载到容器 `/private`。
- `FIRE_NETWORK`：数据库所在的现有私有容器网络。
- `GHCR_IMAGE`、`IMAGE_TAG`、`HOST_PORT`：已验收镜像与可配置宿主机端口。

`docker-compose.ghcr.yml` 保留 Fire 和受限更新器，沿用主分支已经完成的 3D 展示迁出。更新器不开放宿主机端口；自定义图片、字体、图标、分享图继续使用各自挂载目录。

Yahoo 行情与历史的 HTTP 代理直接写在实际 YAML 的 `fire.environment` 中，不从 `.env` 引用：

```yaml
services:
  fire:
    environment:
      STOCKLOG_PROXY: "http://proxy-host:8080"
```

将示例换成实际 HTTP 代理地址；使用 `"off"` 关闭代理。保存后构建项目以重新创建容器，再到「设置 → 投资与行情 → 行情源」检测 Yahoo。只启动或重启旧容器不会更新环境；其他行情和汇率保持原连接方式，真实代理地址仅留在群晖配置中。

镜像包含匹配的 PG 客户端工具，可在构建时通过 `PG_MAJOR` 选择 16、17 或 18，须与实际备份恢复要求核对。容器内不安装数据库服务器。

## 验收

检查 `/health/ready`、系统总览中的实际 PG/Redis 探测、Worker 心跳、后台任务及原请求回执，再核对网页和 App 的具体使用流程。`/api/health` 的 `buildSha` 应与运行镜像对应；仅看到镜像已发布或更新请求已受理，不能当作线上替换成功。

源代码更新后的首次生产数据迁移、镜像发布和线上切换须按已核实的目标另行执行。此前 SQLite 和 Node PG 桥接的部署步骤不再适用。

## 配置核对与 UUID

`npm run platform:config` 检查配置字段；`npm run platform:inspect` 只读检查库中的实例标识。已登记实例沿用其 UUID 和环境，更新时不生成新身份。旧库非空但没有平台标识时，只报告待迁移状态，不能将它作为空库初始化。

首次空库需先选定 UUID、填入 `FIRE_INSTANCE_ID`，再在目标已核实后显式执行 `npm run platform:migrate -- --database EXACT_NAME --initialize-empty`。已有正确标识的库去掉 `--initialize-empty`；迁移前仍需核对备份。启动命令不执行这些操作，`npm run platform:check` 只读核对迁移校验和。

YAML 固定容器中的私有目录，`.env` 的对应路径供本地启动使用。宿主机目录须预先创建并授予 UID/GID 1000、权限 0700。备份密钥与连接密钥分目录保存，`backup.key` 另留安全副本。身份邮件默认关闭，启用时同时配置 SMTP 和精确出站策略，由 Worker 投递；恢复白名单默认空。

配置参考 Alcor-api 的公开 `.env.example`，按 Fire 单一入口调整。仓库、镜像、OAuth 回调及私有目录指向 Fire；内置后端不需要独立的对外端口或代理 IP 白名单。


## 更新器跳过固定镜像

Watchtower 报告 `container uses a pinned image` 时，检查实际容器的镜像引用：

```sh
docker inspect --format '{{.Config.Image}}' fire
```

如果结果以 `sha256:` 开头，容器是按镜像 ID 创建的；项目文件仍写着 `latest` 也不会改变已经创建的容器。启动修复完成后，须按原项目配置和可追踪的镜像标签重新创建容器，并再次核对实际引用、目标提交和服务就绪状态。保留原环境、网络和挂载；先核对目标镜像与当前数据库兼容性。单纯恢复镜像引用不执行数据库迁移。

更新通知已受理或端口可达，都不表示容器已经替换。运行版本未变时可手动重试；每次明确重试使用新请求编号，旧回执与审计继续保留。响应丢失先查询原回执，不自动重复通知。
