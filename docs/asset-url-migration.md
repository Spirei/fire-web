# 素材短地址迁移

显示名称不是存储路径。新素材使用 `lib/assetNaming.cjs`：市场 `US.svg`、股票 `AAPL.png`、币种 `BTC.svg`，无代码使用稳定短哈希。既有 A 股、港股中文股票文件名允许保留。

## 执行

在数据库宿主机的应用目录执行，不通过 SMB 打开运行中的 SQLite：

```sh
node scripts/rename-assets.mjs --dry-run
node scripts/rename-assets.mjs --apply
```

可用 `--db`、`--uploads` 指定目录。工具通过 SQLite backup API 生成一致备份，记录迁移映射；先复制并 SHA-256 校验，再用事务替换数据库 URL。不同内容的重名文件追加摘要，缺失文件不修改引用，旧文件不删除。卡片 ID、钱包持有关系、金额、股票显示名称不变。

备份位于数据库旁的 `asset-migration-backups/<时间>/`。如需回滚，先停止应用写入，再用 SQLite 工具从备份恢复；不要直接覆盖运行中的数据库或将旧 WAL 与恢复后的数据库混用。

## 验证

- `node tests/asset-migration.mjs`：dry-run 不写入、备份、重复执行、碰撞保护、缺失文件、同图共享、自定义图标及中文股票保留。
- `npm run test:review`：SSR/API 同图返回同一 URL，默认素材不会覆盖迁移后的地址，同 inode 替换不会误删图片。
- 浏览器检查手机、平板横竖屏、短桌面不挂载四色门；正常桌面保留。视口模拟不等于实体设备测试。
- 网络面板的 memory/disk cache 行不等于重复下载；验收看实际 URL 和传输字节，不能只数条目。

线上素材迁移与新版代码部署是两件事：迁移即时更新数据，隐藏组件与客户端缓存修复在部署新版镜像后生效。
