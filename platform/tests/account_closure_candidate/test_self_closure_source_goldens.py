"""Execute the actual old closure route with real password crypto and no old I/O."""

import hashlib
import json
import subprocess
from pathlib import Path


def test_exact_old_closure_branches_and_ordinary_member_availability():
    root = Path(__file__).parents[1] / "fixtures/account-closure-source"
    manifest = json.loads((root / "source-sha256.json").read_text())
    for name, item in manifest.items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == item["sha256"]
    result = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("run_old_closure.cjs")),
            str(root),
        ],
        input=json.dumps(
            [
                {"unauthenticated": True},
                {"exhausted": True},
                {"password": "WrongSynthetic9"},
                {"factor": True, "factorValid": False},
                {"role": "admin", "adminCount": 1},
                {"role": "user", "factor": True},
                {"role": "admin", "adminCount": 2},
            ]
        ),
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value["actualRoute"] and value["actualScrypt"] and value["noOldDatabaseOrFilesystemOrTransport"]
    cases = value["results"]
    assert [case["status"] for case in cases] == [401, 429, 403, 403, 400, 200, 200]
    assert [case["body"] for case in cases[:5]] == [
        {"error": "未登录"},
        {"error": "尝试过于频繁，请稍后再试"},
        {"error": "当前密码错误"},
        {"error": "二次验证失败"},
        {"error": "不能删除最后一个管理员账号"},
    ]
    assert all(not case["statements"] for case in cases[:5])
    assert cases[5]["body"] == cases[6]["body"] == {"ok": True}
    assert cases[5]["statements"] == cases[6]["statements"] == ["DELETE FROM users WHERE id = ?"]
    assert cases[5]["factors"] == 1
    client = (root / "legacy-client-close.ts").read_text()
    assert '"/api/v1/auth/delete-account"' in client
    assert "JSON.stringify({ password: deletePassword, code: deleteTotpCode })" in client
    assert "receipt_token" not in client and "request_id" not in client
