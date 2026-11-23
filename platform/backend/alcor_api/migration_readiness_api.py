"""Admin read-only VPS migration readiness preflight over single PG + local directories."""

import asyncio
import os
import stat
from pathlib import Path

from fastapi import HTTPException, Request

from . import __version__
from .card_preferences_protocol import wire_response
from .personal_ledger_archive import PRIVATE
from .record_file_api import actor
from .security import assert_expected_account, lock_read_identity

PATH = "/api/personal-data-transfer/migration-readiness"
MAX_SCAN_FILES = 100_000


def _scan_dir(path: Path | None, key: str, label: str, purpose: str):
    if path is None:
        return {
            "key": key,
            "label": label,
            "purpose": purpose,
            "configured": False,
            "exists": False,
            "modeOctal": None,
            "fileCount": 0,
            "totalBytes": 0,
            "truncated": False,
            "required": True,
        }
    try:
        info = os.stat(path)
        if not stat.S_ISDIR(info.st_mode):
            return {
                "key": key,
                "label": label,
                "purpose": purpose,
                "configured": True,
                "exists": False,
                "modeOctal": None,
                "fileCount": 0,
                "totalBytes": 0,
                "truncated": False,
                "required": True,
            }
        mode = f"{stat.S_IMODE(info.st_mode):04o}"
        files = 0
        total = 0
        truncated = False
        stack = [path]
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            files += 1
                            try:
                                total += entry.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                            if files >= MAX_SCAN_FILES:
                                truncated = True
                                stack.clear()
                                break
            except OSError:
                continue
        return {
            "key": key,
            "label": label,
            "purpose": purpose,
            "configured": True,
            "exists": True,
            "modeOctal": mode,
            "fileCount": files,
            "totalBytes": total,
            "truncated": truncated,
            "required": True,
        }
    except OSError:
        return {
            "key": key,
            "label": label,
            "purpose": purpose,
            "configured": True,
            "exists": False,
            "modeOctal": None,
            "fileCount": 0,
            "totalBytes": 0,
            "truncated": False,
            "required": True,
        }


def _scan_all_directories(settings):
    specs = (
        ("backupSecretDir", "备份密钥目录", "解密加密整库备份（backup.key）", settings.backup_secret_dir),
        ("connectionSecretDir", "连接密钥目录", "解密行情源、汇率源与邮件加密凭据", settings.connection_secret_dir),
        ("fileRoot", "私有文件目录", "券商账单原件、自选分组图标与私有附件", settings.file_root),
        ("assetRoot", "素材与卡面目录", "股票/市场自定义图标与卡面库素材", settings.asset_root),
    )
    return [_scan_dir(path, key, label, purpose) for key, label, purpose, path in specs]


def mount_migration_readiness(app, db):
    @app.get(PATH)
    async def migration_readiness(request: Request):
        if request.query_params:
            raise HTTPException(400, "不接受这些查询参数")
        who = await actor(request, db, write=False)
        assert_expected_account(request, who.id)
        async with db.connection() as conn, conn.transaction():
            await lock_read_identity(conn, who, require_admin=True)
            instance = await (await conn.execute(
                "SELECT instance_id, environment, product FROM alcor_instance WHERE singleton"
            )).fetchone()
            db_meta = await (await conn.execute(
                "SELECT current_database() AS name, pg_database_size(current_database()) AS size_bytes"
            )).fetchone()
            mig_meta = await (await conn.execute(
                "SELECT count(*) AS total, max(name) AS latest FROM schema_migrations"
            )).fetchone()
            counts = await (await conn.execute("""
                SELECT
                    (SELECT count(*) FROM users) AS users,
                    (SELECT count(*) FROM portfolio_records WHERE deleted_at IS NULL) AS holdings,
                    (SELECT count(*) FROM native_ledger_heads) AS native_ledgers,
                    (SELECT count(DISTINCT owner_id) FROM owner_ledger_checkpoints) AS checkpoint_owners,
                    (SELECT count(*) FROM owner_ledger_events) AS ledger_events,
                    (SELECT count(*) FROM portfolio_daily_results) AS daily_snapshots
            """)).fetchone()
            checkpoint_scope = await (await conn.execute("""
                WITH targets AS (
                    SELECT owner_id FROM native_ledger_heads
                    UNION
                    SELECT owner_id FROM database_migration_history_imports
                )
                SELECT
                    count(*) AS total_targets,
                    count(*) FILTER (
                        WHERE EXISTS (
                            SELECT 1 FROM owner_ledger_checkpoints c WHERE c.owner_id = targets.owner_id
                        )
                    ) AS sealed_targets
                FROM targets
            """)).fetchone()
            latest_backup = await (await conn.execute("""
                SELECT id, created_at, verified_at, bytes, software_version, sha256
                FROM backups
                ORDER BY created_at DESC
                LIMIT 1
            """)).fetchone()

        directories = await asyncio.to_thread(_scan_all_directories, db.settings)
        instance_id = str(instance["instance_id"]) if instance else None
        total_targets = checkpoint_scope["total_targets"]
        sealed_targets = checkpoint_scope["sealed_targets"]
        unsealed_targets = max(0, total_targets - sealed_targets)
        all_sealed = unsealed_targets == 0

        blockers = []
        recommendations = []
        if not all_sealed:
            blockers.append(f"仍有 {unsealed_targets} 个账本账号尚未固化单库期初核准点，迁移前请先在「账本核准」固化")
        for item in directories:
            if item["configured"] and not item["exists"]:
                blockers.append(f"{item['label']} 已配置但目录不存在")
            elif item["exists"] and item["key"] in ("backupSecretDir", "connectionSecretDir") and item["modeOctal"] != "0700":
                recommendations.append(f"{item['label']} 当前权限为 {item['modeOctal']}，迁入新 VPS 后请收紧为 0700")
        if latest_backup is None:
            recommendations.append("迁移前建议先执行一次加密联合备份作为离线回滚底稿")
        elif latest_backup["verified_at"] is None:
            recommendations.append("最近一次整库备份尚未校验，迁移前建议先校验备份完整性")

        return wire_response({
            "ready": len(blockers) == 0,
            "blockers": blockers,
            "recommendations": recommendations,
            "database": {
                "name": db_meta["name"],
                "instanceId": instance_id,
                "environment": instance["environment"] if instance else db.settings.environment,
                "softwareVersion": __version__,
                "migrationCount": mig_meta["total"],
                "latestMigration": mig_meta["latest"],
                "sizeBytes": db_meta["size_bytes"],
                "singleDatabaseAuthority": True,
                "counts": {
                    "users": counts["users"],
                    "holdings": counts["holdings"],
                    "nativeLedgers": counts["native_ledgers"],
                    "checkpointOwners": counts["checkpoint_owners"],
                    "ledgerEvents": counts["ledger_events"],
                    "dailySnapshots": counts["daily_snapshots"],
                },
            },
            "checkpoints": {
                "totalTargets": total_targets,
                "sealedTargets": sealed_targets,
                "unsealedTargets": unsealed_targets,
                "allSealed": all_sealed,
                "diskMigrationArchiveNeeded": not all_sealed,
            },
            "redis": {
                "configured": bool(db.settings.redis_url),
                "statelessCacheOnly": True,
                "migrationRequired": False,
                "aclKeyPrefix": f"alcor:{instance_id}:read-budget:*" if instance_id else None,
            },
            "directories": directories,
            "latestBackup": {
                "createdAt": latest_backup["created_at"].isoformat(),
                "verifiedAt": latest_backup["verified_at"].isoformat() if latest_backup["verified_at"] else None,
                "bytes": latest_backup["bytes"],
                "softwareVersion": latest_backup["software_version"],
                "sha256Prefix": latest_backup["sha256"][:16],
            } if latest_backup else None,
        }, PRIVATE)
