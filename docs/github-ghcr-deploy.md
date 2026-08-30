# GitHub 私有仓库 + GHCR 部署

## 一次性设置

1. 在 GitHub 创建**私有**仓库，建议仓库名使用小写 `fire-web`。
2. 只把 `fire-web/` 项目提交到仓库；不要提交 `data/`、`.env`、`.next`、`node_modules` 或 Docker 导出包。
3. 将本目录的 `.github/workflows/docker-publish.yml` 一并提交。
4. `main` 分支每次 push 通过 TypeScript 检查后，GitHub Actions 会构建 `linux/amd64` 并推送到私有 GHCR。镜像标签包含 `latest`、短 commit SHA 和 Git tag。

GitHub Actions 使用仓库自带的 `GITHUB_TOKEN` 发布镜像；GHCR 私有镜像在群晖拉取时需要 GitHub Personal Access Token（classic），至少授予 `read:packages`。

## 群晖一次性设置

把 `docker-compose.ghcr.yml` 复制到 `/volume1/docker/fire/`，并将其中的镜像名改成自己的仓库，或在同目录 `.env` 增加：

```dotenv
GHCR_IMAGE=ghcr.io/你的用户名/fire-web
IMAGE_TAG=latest
```

在群晖 Container Manager 的终端执行一次登录（不要把 Token 写进 Compose 文件）：

```bash
docker login ghcr.io
```

登录用户名填写 GitHub 用户名，密码填写 Personal Access Token。

## 日常更新

本地修改并推送：

```bash
git add .
git commit -m "describe change"
git push origin main
```

Actions 完成后，在群晖执行：

```bash
cd /volume1/docker/fire
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```

Registry 会复用未变化的镜像层，不再需要每次手工搬运完整 tar.gz。数据库和上传文件仍在 `/volume1/docker/fire/data`、`/volume1/docker/fire/uploads`，更新镜像不会覆盖它们。

## 回滚

Actions 生成的短 SHA 可作为固定版本：

```bash
IMAGE_TAG=abc1234 docker compose -f docker-compose.ghcr.yml up -d --force-recreate
```

回滚前后都不要删除 `data/` 或 `uploads/`。
