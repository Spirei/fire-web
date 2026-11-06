import json
import subprocess
from pathlib import Path

from frozen_legacy import source_root

FILES = [
    "app/api/users/route.ts",
    "app/api/users/[id]/route.ts",
    "app/api/users/[id]/reset-password/route.ts",
    "app/api/users/[id]/disable-totp/route.ts",
    "lib/auth.ts",
    "lib/password.ts",
    "lib/adminStepUp.ts",
]


def old(commands):
    root = source_root("ALCOR_ADMIN_LEGACY_ROOT", FILES)
    payload = {
        "users": [
            {"id": "admin", "username": "Admin", "role": "admin", "uid": "1", "online": True},
            {
                "id": "member",
                "username": "Member",
                "nickname": "Source nickname",
                "role": "user",
                "uid": "2",
                "online": True,
            },
            {"id": "target", "username": "Target", "role": "user", "uid": "3"},
        ],
        "commands": commands,
    }
    result = subprocess.run(
        ["node", "--experimental-vm-modules", str(Path(__file__).with_name("run_old_admin.cjs")), str(root)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert (
        value["memoryOnly"]
        and value["builtInNodeOnly"]
        and value["realSourceCrypto"]
        and value["downstreamCallbacksStubbed"]
    )
    return value


def test_exact_old_directory_shape_role_boundary_and_explicit_app_scope_downgrade():
    value = old(
        [
            {"route": "directory", "method": "GET"},
            {"route": "directory", "method": "GET", "actor": "member"},
            {"route": "directory", "method": "GET", "auth": "anonymous"},
            {"route": "directory", "method": "GET", "auth": "app"},
            {"route": "directory", "method": "GET", "auth": "legacy-bearer"},
        ]
    )
    rows = value["results"]
    assert [r["status"] for r in rows] == [200, 403, 401, 403, 200]
    users = rows[0]["body"]["users"]
    assert rows[0]["body"]["me"] == "admin"
    assert [r["id"] for r in users] == ["admin", "member", "target"]
    assert users[1]["nickname"] == "Source nickname" and users[1]["online"] is True
    assert users[2]["online"] is False and users[2]["recordsCount"] == 0
    assert set(users[0]) == {
        "id",
        "username",
        "nickname",
        "uid",
        "email",
        "emailVerified",
        "avatar",
        "role",
        "isTest",
        "createdAt",
        "recordsCount",
        "online",
        "totpEnabled",
    }


def test_exact_old_put_admin_stepup_last_admin_and_delete_self_boundaries():
    value = old(
        [
            {"route": "user", "method": "PUT", "target": "target", "body": {"username": " Renamed "}},
            {"route": "user", "method": "PUT", "target": "target", "body": {"role": "admin"}},
            {
                "route": "user",
                "method": "PUT",
                "target": "target",
                "body": {"role": "admin", "currentPassword": "Synthetic9Pass"},
            },
            {
                "route": "user",
                "method": "DELETE",
                "target": "admin",
                "body": {"currentPassword": "Synthetic9Pass"},
            },
            {
                "route": "user",
                "method": "DELETE",
                "target": "target",
                "body": {"currentPassword": "Synthetic9Pass"},
            },
            {
                "route": "user",
                "method": "PUT",
                "target": "admin",
                "body": {"role": "user", "currentPassword": "Synthetic9Pass"},
            },
        ]
    )
    assert [r["status"] for r in value["results"]] == [200, 403, 200, 400, 200, 409]
    assert value["results"][0]["body"]["user"]["username"] == "Renamed"
    assert any(e[:3] == ["security", "admin", "admin.role_change_rejected"] for e in value["events"])
    assert ["resource-purge", "target"] in value["events"] and ["release-quotes", "target"] in value["events"]


def test_exact_old_recovery_actual_password_hash_and_one_time_factor_consumer():
    value = old(
        [
            {
                "route": "reset",
                "method": "POST",
                "target": "target",
                "factorEnabled": True,
                "body": {
                    "newPassword": "ChangedSynthetic9Pass",
                    "currentPassword": "Synthetic9Pass",
                    "code": "wrong",
                },
            },
            {
                "route": "reset",
                "method": "POST",
                "target": "target",
                "body": {
                    "newPassword": "ChangedSynthetic9Pass",
                    "currentPassword": "Synthetic9Pass",
                    "code": "123456",
                },
            },
            {
                "route": "disable",
                "method": "POST",
                "target": "admin",
                "body": {"currentPassword": "Synthetic9Pass", "code": "123456"},
            },
            {
                "route": "disable",
                "method": "POST",
                "target": "target",
                "factorEnabled": False,
                "body": {"currentPassword": "Synthetic9Pass"},
            },
        ]
    )
    assert [r["status"] for r in value["results"]] == [403, 200, 403, 400]
    assert value["results"][1]["body"] == {"ok": True, "totpDisabled": True, "passkeysRevoked": True}
    assert next(row for row in value["checks"] if row["id"] == "target")["newPasswordValid"] is True
    assert [row["code"] for row in value["factorCalls"]] == ["wrong", "123456", "123456"]
    assert any(e[:3] == ["security", "admin", "admin.password_reset_rejected"] for e in value["events"])
