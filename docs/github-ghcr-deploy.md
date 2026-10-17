# GitHub 私有仓库 + GHCR 部署

## 一次性设置

1. 在 GitHub 创建**私有**仓库，建议仓库名使用小写 `fire-web`。
2. 只把 `fire-web/` 项目提交到仓库；不要提交 `data/`、`.env`、`.next`、`node_modules` 或 Docker 导出包。
3. 将本目录的 `.github/workflows/docker-publish.yml` 一并提交。
4. `main` 分支每次 push 只执行 TypeScript、公开仓库与部署一致性检查；GitHub Actions 在每天北京时间 00:00 统一构建 `linux/amd64` 并推送到私有 GHCR。镜像标签包含 `latest`、短 commit SHA 和 Git tag。

> `workflow_dispatch` 仅用于用户明确要求“立即上线 / 立即发布 / 手动推送”的情况。日常修改、“同步线上代码”或“线上版同步更新”都不得自动触发手动 GHCR 发布。

GitHub Actions 使用仓库自带的 `GITHUB_TOKEN` 发布镜像；GHCR 私有镜像在群晖拉取时需要 GitHub Personal Access Token（classic），至少授予 `read:packages`。

## 群晖一次性设置

把 `docker-compose.ghcr.yml` 复制到 `/volume1/docker/fire/`，并将其中的镜像名改成自己的仓库，或在同目录 `.env` 增加：

```dotenv
GHCR_IMAGE=ghcr.io/你的用户名/fire-web
IMAGE_TAG=latest
WATCHTOWER_HTTP_API_TOKEN=用_openssl_rand_hex_32_生成的随机值
DOCKER_CONFIG_DIR=/root/.docker
```

随机值可用 `openssl rand -hex 32` 生成。`DOCKER_CONFIG_DIR` 指向执行 `docker login ghcr.io` 后生成 `config.json` 的目录，默认是 root 用户的 `/root/.docker`；该目录以只读方式提供给更新器。`docker-compose.ghcr.yml` 会启动一个仅在 Compose 内网可访问的 `fire-updater`：它只更新同时带有 Alcor 专属标签与 scope 的容器，8080 端口不会映射到群晖。不要把 Docker Socket 或 Watchtower API 暴露到局域网 / 公网。

在群晖 Container Manager 的终端执行一次登录（不要把 Token 写进 Compose 文件）：

```bash
docker login ghcr.io
```

登录用户名填写 GitHub 用户名，密码填写 Personal Access Token。

**挂载目录属主（必做一次）**：容器以非 root 运行（容器内 `node` 用户 = uid 1000），而 `DATA_DIR` / `UPLOADS_DIR`
是宿主机 bind mount，属主由宿主机决定。请执行一次：

```bash
cd /volume1/docker/fire
chown -R 1000:1000 data uploads && chmod -R u+rwX data uploads
```

否则镜像升级到非 root 版本后，容器会在启动脚本写数据卷时报 `EACCES` 并被 `restart: unless-stopped`
反复重启（日志形如 `EACCES: permission denied, open '/app/data/duan-posts.json.<pid>.tmp'`）。
完整排查步骤见 `docs/synology-deploy.md` 的「排查：升级镜像后容器无限重启，日志只有 EACCES」。

**插图 / 字体 / 图标素材（必做一次）**：`public/images`、`public/fonts`、`public/icons`、`public/share`
不进仓库也不进镜像，Compose 会把宿主机 `./images`、`./fonts`、`./icons`、`./share`
以只读方式挂到 `/app/public/` 下。请在 `docker-compose.ghcr.yml` 同目录建好这四个目录并把素材放进去，
否则 FIRE 页面会出现「小丑鱼不见了」这类静默视觉缺失（日志会提示 `缺少部署素材`）。
步骤与验证命令见 `docs/synology-deploy.md` 的「1d. 挂载插图 / 字体 / 图标素材」。

## 日常更新

本地修改并推送：

```bash
git add .
git commit -m "describe change"
git push origin main
```

Actions 完成后，可由管理员打开 `/deploy-status`，点击流程中的“更新群晖”。页面会通知 Watchtower 拉取最新 GHCR 镜像，并观察 Alcor 重启与健康恢复。

首次增加 Watchtower 服务、修改端口 / 环境变量 / 挂载目录，或网页更新不可用时，仍在群晖执行：

```bash
cd /volume1/docker/fire
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```

网页按钮只替换镜像，不会同步新的 Compose 配置；这是刻意的安全边界。服务端接口固定调用 Compose 内网地址，不接受浏览器传入容器名、镜像名或命令，且仅管理员可操作。

Registry 会复用未变化的镜像层，不再需要每次手工搬运完整 tar.gz。数据库和上传文件仍在 `/volume1/docker/fire/data`、`/volume1/docker/fire/uploads`，更新镜像不会覆盖它们。

## 回滚

### 暂停包含指定功能的发布

仓库 Actions 变量 `ALCOR_RELEASE_HOLD_ANCESTOR` 可填入完整的 40 位提交 SHA。
包含该提交的版本（包括后续提交）仍运行检查，但每日和手动任务均跳过镜像发布；
不包含该提交的分支不受此开关影响。变量格式错误或无法读取提交时阻止发布。
这不会停止定时任务、回退源码或重启现有容器。已经开始的旧工作流不受新配置追溯控制，须单独核对并取消。

2026-10-17 按用户暂不发布个人券商 API 的选择，暂停祖先为
`3216d92546912237b55128942cd184bebb97b06f`，指定手动任务 `39027573259` 已取消；
生产保留 `cd7c9223b3376c795d1cff9e8fa278cf3b53aa85`。

仅在用户重新授权发布后，删除该变量即可恢复原有每日发布机制：

```bash
gh variable delete ALCOR_RELEASE_HOLD_ANCESTOR --repo Spirei/fire-web
```

删除变量本身不会立即发布。立即发布仍需用户明确授权，再触发原工作流。
发布去重只认实际发布步骤成功的运行，暂停期间的成功检查不会被误认为已有镜像。
由于暂停版本没有新镜像，管理页自动更新及 Watchtower 不会因此获得该版本；此开关不是运行时容器锁，也不能阻止外部另行推送镜像。

Actions 生成的短 SHA 可作为固定版本：

```bash
IMAGE_TAG=abc1234 docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```

回滚前后都不要删除 `data/` 或 `uploads/`。
