# Fire 投资记实 —— 群晖（Docker）部署

面向 **群晖 x86_64（Docker / Container Manager）** 的单机部署。
镜像不含数据：SQLite 数据库与上传素材通过 `volume` 挂载到宿主机目录，镜像可随时替换重建而不丢数据。

## 打包内容
- `Dockerfile` —— 多阶段（deps → build → runner），Node 22-slim；`next start` 运行。
- `docker-compose.ghcr.yml` —— 群晖唯一 Compose 入口（拉 GHCR 镜像）；端口和持久化目录读取 `.env` 的 `HOST_PORT`、`DATA_DIR`、`UPLOADS_DIR`，未配置时默认 `3000`、`./data`、`./uploads`。
- `.dockerignore` —— 排除 node_modules / .next / data / uploads / .env / .git。

## 部署步骤

### 1. 把项目目录拷到群晖
用 SMB / WebDAV / Git 把整个 `fire-web/` 目录放到群晖指定共享文件夹（例如 `docker/fire`）。
> 只拷源码，**不含** `node_modules`、`.next`、`data`、`public/uploads`（镜像内重建，数据走挂载）。

### 1b. 手动放置卡面素材（重要）
卡面素材（`public/uploads/cards/`，430 张卡、约 313MB）**不在 Git 仓库、也不在镜像里**，
因为体积太大会拖慢仓库克隆与镜像构建。部署后需要手动放一次：

1. 在宿主机（群晖）的 uploads 目录下建好 `cards/`，例如 `UPLOADS_DIR` 默认是 `./uploads`，
   即 `/volume1/docker/fire/uploads/cards/`；容器内对应 `/app/public/uploads/cards/`。
2. 把本机 `fire-web/public/uploads/cards/` 整个目录（含 `manifest.json` 与各地区子目录）
   用 SMB / File Station / `scp -r` 传上去。
3. 刷新「卡面库」即可看到素材；`manifest.json` 是索引，缺了它卡面库会显示为空。

> 以后素材库新增卡片，同样在本地跑一次抓取脚本后重传这个目录即可，不需要重新构建镜像。

> 四色门侧栏的 4 个素材（`public/uploads/feature/four-door/{window,dial,pointer,cursor-hand}.png`）**已随镜像提供**，
> 首次启动由容器启动脚本自动播种到 uploads 卷，不需要手动传；如果侧栏入口"闪一下就消失"，说明这四个文件缺失
> （老镜像 + 手动挂载的 uploads 目录里没有它们），重新 `up -d --force-recreate` 让 entrypoint 播种即可。

### 1c. 挂载目录属主必须是 1000:1000（重要）
容器自 v0.1.31 起以**非 root** 运行（容器内的 `node` 用户 = **uid 1000 / gid 1000**），
而 `DATA_DIR`、`UPLOADS_DIR` 是宿主机 bind mount —— 挂载会覆盖镜像里的属主，最终以**宿主机目录权限**为准。
所以部署/升级后请执行一次（把路径换成 `.env` 里的真实值）：

```bash
cd /volume1/docker/fire
chown -R 1000:1000 data uploads
chmod -R u+rwX  data uploads
```

- 这两条命令只需执行一次，属主会随卷保留，之后重建容器、升级镜像都不用再改。
- DSM 的 File Station 里这些文件会显示成 UID `1000`（DSM 没有这个用户），但 admin 有特权，照样能浏览和编辑。
- 只改 `uploads` 不改 `data` 不够：SQLite 的建库、WAL 与临时文件都在 `data/` 下。

### 1d. 挂载插图 / 字体 / 图标素材（少了会「丢鱼」）

FIRE 页面那对游动的小丑鱼、礁石贴图，以及全站自定义字体与图标，属于**部署者自行提供的素材**：
它们不进 Git 仓库、也不进镜像（见 `ASSETS.md`），镜像里连这些目录都不存在。所以必须从宿主机挂进去，
否则 `/images/fire/clownfish-family.png` 直接 404 —— 页面不会报错，只是**鱼不见了**（鱼和礁石是 sprite 贴图，
缺图就是一片空白，很容易被当成动画 bug）。

在 `/volume1/docker/fire` 下建好这四个目录并放入文件（目录名与 Compose 默认值一致，无需改 Compose）：

```bash
cd /volume1/docker/fire
mkdir -p images fonts icons share

# 在 Mac 上从本项目目录上传（按需只传 images 也能先把鱼找回来）：
#   scp -r public/images/fire  <群晖账号>@<群晖IP>:/volume1/docker/fire/images/
#   scp    public/fonts/*      <群晖账号>@<群晖IP>:/volume1/docker/fire/fonts/
#   scp    public/icons/*      <群晖账号>@<群晖IP>:/volume1/docker/fire/icons/
#   scp    public/share/*      <群晖账号>@<群晖IP>:/volume1/docker/fire/share/

chown -R 1000:1000 images fonts icons share
docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```

验证（两条都应返回 `200`）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/images/fire/clownfish-family.png
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/images/fire/coral-reef-transparent.png
```

- 这四个目录是**只读挂载**（`:ro`），容器只读不写，不会影响备份与数据卷。
- 路径可用 `.env` 覆盖：`IMAGES_DIR` / `FONTS_DIR` / `ICONS_DIR` / `SHARE_DIR`。
- 目录为空或未挂载时行为与旧版一致：对应资源 404，但**不影响服务启动**；此时容器启动日志会打印一行
  `[entrypoint] 提示：/app/public 下缺少部署素材：…`，看到它就说明有素材没放。
- 素材是宿主机文件、不在镜像里，所以之后升级镜像、`up -d --force-recreate` 都不会把它们覆盖掉。

### 2. 准备生产环境变量
在项目根目录创建 `.env`（复制 `.env.example` 后填写）：
```bash
cd /volume1/docker/fire
cp .env.example .env
# 编辑 .env，至少填写首次建库的管理员（密码 8-128 位且含字母+数字）：
#   INITIAL_ADMIN_USERNAME=admin
#   INITIAL_ADMIN_PASSWORD=你的强密码
```
其余为可选：`STOCKLOG_PROXY`（出站代理）、`DEEPSEEK_API_KEY`（截图导入走云端 OCR，不配则回退本地识别）。

### 3a. 命令行拉取并启动（SSH / 计划任务）
```bash
cd /volume1/docker/fire
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```
- 看日志 `docker compose -f docker-compose.ghcr.yml logs -f fire`，出现监听 3000 即成功。
- 详细镜像登录与更新步骤见 `docs/github-ghcr-deploy.md`。

### 3b. 或用群晖 Container Manager（图形界面）
1. Container Manager → **项目** → **新增**。
2. 名称 `fire`，来源选「上传 docker-compose.ghcr.yml」或指向项目目录。
3. 启动后，项目状态为「运行中」。

### 4. 访问
- 浏览器打开 `http://群晖IP:3000`。
- 用 `.env` 里 `INITIAL_ADMIN_USERNAME/PASSWORD` 登录（仅首次空库时创建管理员）。
- 如果端口 3000 被占用，在 `.env` 设置 `HOST_PORT=3001`，无需修改 Compose 文件。

## 数据持久化与备份
- **SQLite 数据库 / 附件 / 备份 / 缓存** → `/volume1/docker/fire/data/`（挂载到 `/app/data`）。
- **上传素材**（图标 / 头像 / 截图）→ `/volume1/docker/fire/uploads/`（挂载到 `/app/public/uploads`）。
- **插图 / 字体 / 图标 / 分享图** → `/volume1/docker/fire/{images,fonts,icons,share}/`（只读挂载到 `/app/public/` 下同名目录，见「1d」）。
- 备份：直接打包 `data/` 目录，或用「设置 → 个人信息 → 网站数据导出」生成 JSON 备份文件。
- 升级：`docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d --force-recreate`，数据不动。

## 排查：升级镜像后容器无限重启，日志只有 EACCES

症状：`docker ps` 里容器总是刚起来又重建（`RestartCount` 持续增长），日志末尾是

```
Error: EACCES: permission denied, open '/app/data/duan-posts.json.<pid>.tmp'
    at file:///app/scripts/seed-trading-square.mjs:30:5
```

原因：挂载目录属主不是容器内的 uid 1000（见「1c. 挂载目录属主必须是 1000:1000」）。
**v0.1.31 之前的镜像以 root 运行，所以从来不会暴露这个问题**，升级到非 root 之后才第一次出现。

处理：

```bash
cd /volume1/docker/fire
chown -R 1000:1000 data uploads && chmod -R u+rwX data uploads
docker restart fire
docker logs --tail 20 fire          # 期望看到 Next.js 的 ✓ Ready，不再有 EACCES
docker inspect fire --format 'status={{.State.Status}} restarts={{.RestartCount}}'
```

现版本启动脚本已内置自检：数据目录不可写时会直接打印上面那行 `chown` 命令再退出；
公开缓存种子（`seed-trading-square.mjs`）失败只告警、不再阻塞启动，因此不会因为种子问题变成无限重启。
若该共享启用了 Windows ACL 导致 `chown` 不生效，可临时在 `.env` 里把 `IMAGE_TAG` 钉到升级前的
`sha-…` 标签回滚，再按上面的方式处理权限。

## 排查：FIRE 页面的小丑鱼不见了 / 图片、字体、图标 404

症状：FIRE 页面里那对游动的小丑鱼（父子鱼）与礁石贴图不见了，页面本身不报错；或浏览器控制台里
`/images/...`、`/fonts/...`、`/icons/...` 一律 404。

原因：这些素材不进仓库也不进镜像，只从宿主机挂载提供；旧版部署没有这几个挂载点，所以线上必然是 404
（本地 `next dev` 直接读源码目录下的 `public/`，因此本地看着一切正常，容易误判成"线上代码有 bug"）。

处理：按「1d. 挂载插图 / 字体 / 图标素材」把文件放到宿主机对应目录并重建容器，然后用同一节里的
两条 `curl` 验证 200。日志里出现 `[entrypoint] 提示：/app/public 下缺少部署素材：…` 时，
按提示补对应目录即可。

排查命令：

```bash
cd /volume1/docker/fire
ls -l images/fire/                       # 期望看到 clownfish-family.png / coral-reef-transparent.png
docker compose -f docker-compose.ghcr.yml config | grep -A8 'volumes'   # 期望看到四个只读挂载
docker logs --tail 30 fire | grep '部署素材'
```

## 说明 / 注意
- **富途 OpenD 桥接**（`scripts/futu_quotes.py`）已由共用 `Dockerfile` 打包 Python 运行时与 `futu-api`。生产容器按设置连接 OpenD；本地 `next dev` 默认跳过（`STOCKLOG_FUTU=on` 可开启），避免抢免费额度的唯一连接。未配置或不可达时行情自动回退腾讯 / 雅虎（腾讯源已支持美股 / 港股 / A股 / 日股 / 韩股）。在设置→股票设置→交易·富途里把 OpenD 主机填写为纯 IP/主机名（如 `192.168.x.x`，不要带 `http://`），端口通常为 `11111`，并确保容器能访问该端口。
- **资源**：默认不写死 CPU / 内存限制，请在 Container Manager 中按自己的 NAS 配置设置。
- **健康检查**：每 60s 请求 `/api/settings/public`，失败 5 次标记 unhealthy（不影响运行）。
- 默认 `CMD` 为 `npx next start -H 0.0.0.0 -p 3000`；若后续需要自定义启动（如迁移数据、预建库），可改为挂载自定义 `entrypoint.sh`。
