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

镜像仍由现有 GHCR 发布流程生成。部署页只接收带固定摘要的发布记录。首次关联现有数据库、安装更新器或更改项目配置，按已核实的目标另行执行。

## 配置核对与 UUID

`npm run platform:config` 检查配置字段；`npm run platform:inspect` 只读检查库中的实例标识。已登记实例沿用其 UUID 和环境，更新时不生成新身份。旧库非空但没有平台标识时，只报告待迁移状态，不能将它作为空库初始化。

首次空库需先选定 UUID、填入 `FIRE_INSTANCE_ID`，再在目标已核实后显式执行 `npm run platform:migrate -- --database EXACT_NAME --initialize-empty`。已有正确标识的库去掉 `--initialize-empty`；迁移前仍需核对备份。启动命令不执行这些操作，`npm run platform:check` 只读核对迁移校验和。

YAML 固定容器中的私有目录，`.env` 的对应路径供本地启动使用。宿主机目录须预先创建并授予 UID/GID 1000、权限 0700。备份密钥与连接密钥分目录保存，`backup.key` 另留安全副本。身份邮件默认关闭，启用时同时配置 SMTP 和精确出站策略，由 Worker 投递；恢复白名单默认空。

配置参考 Alcor-api 的公开 `.env.example`，按 Fire 单一入口调整。仓库、镜像、OAuth 回调及私有目录指向 Fire；内置后端不需要独立的对外端口或代理 IP 白名单。


## 部署页更新群晖

新版沿用 `fire-updater` 服务名、部署页和原请求回执。更新器运行在 Fire 进程之外，只监听 Compose 私网。现有群晖需要一次手动升级 Compose 和配套更新器，随后日常更新使用部署页。

- `FIRE_DEPLOYMENT_PROJECT_DIR` 填当前群晖项目的绝对路径。更新器读取同目录的 `docker-compose.ghcr.yml` 和 `.env`。保留 Container Manager 使用的项目名。
- `FIRE_DOCKER_SOCKET_GID` 填宿主 Docker Socket 的组 ID。私有目录须允许容器用户 1000 写入。现有更新器 Token 和私网地址可继续使用。给 `FIRE_UPDATER_IMAGE_TAG` 配置已验证支持此流程的镜像版本。日常更新只替换 Fire 服务，更新器在维护窗口中保持运行。

点击「推送新镜像」后，更新器核对获准的镜像摘要、运行项目、数据库名称、实例和环境，以及目标镜像内置的迁移摘要。数据库已符合目标结构时直接切换。需要迁移时暂停同项目的 Fire 写入，再封存包含最后一次提交的备份。更新器在隔离的 PostgreSQL 实例中完整恢复备份，并复核实例身份和迁移记录。备份通过验证后，才用目标镜像执行缺少的迁移。

切换使用已通过预检的固定摘要。更新器逐轮检查所有目标容器的实际镜像、运行状态、API 提交和 readiness。启用 Worker 时，还须收到切换后产生的目标 Worker 心跳。核对通过后才记录成功。

刷新页面或重启更新器后，原请求仍可接续。若迁移失败且数据库仍匹配旧镜像，更新器恢复旧服务。旧服务恢复写入后，再次迁移会重新备份。如果迁移已经提交而目标无法启动，流程停在维护状态，保留当前库和经验证的备份，使用原编号继续核对和启动目标镜像。

维护期间部署页可能暂时不可达。群晖终端可在同一个更新器内查询或继续原编号。备份文件、摘要和进度保存在私有目录 `state/deployments`。

```sh
docker exec fire-updater /platform/.venv/bin/python -m alcor_api.deployment_runner --status REQUEST_UUID
docker exec fire-updater /platform/.venv/bin/python -m alcor_api.deployment_runner --resume REQUEST_UUID
```

仍运行旧 Watchtower 的环境继续使用原先的更新合同。需迁移的发布按旧流程维护，直到手动安装新版 Fire 和配套更新器。Fire 的常规启动只校验数据库，迁移在显式维护命令中执行。
