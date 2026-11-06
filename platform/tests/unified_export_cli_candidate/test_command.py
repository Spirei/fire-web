"""Run the actual offline command against an encrypted synthetic export."""
import json
from pathlib import Path
import subprocess
import sys

from unified_export_candidate.bundle_factory import write_bundle


def test_offline_command_verifies_without_applying_and_rejects_a_wrong_private_key(tmp_path):
    bundle, key, _manifest = write_bundle(tmp_path)
    original = bundle.read_bytes()
    key_file = tmp_path / "separate-key"
    key_file.write_bytes(key)
    key_file.chmod(0o600)
    tool = Path(__file__).resolve().parents[2] / "tools/verify-unified-export.py"
    command = [sys.executable, str(tool), str(bundle), "--key-file", str(key_file)]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["state"] == "verified_not_applied"
    assert result["applied"] is False and result["sqlExecuted"] is False
    assert result["tableCount"] == 1 and result["rowCount"] == "1"
    assert completed.stderr == ""
    assert "private-owner" not in completed.stdout and "private-database" not in completed.stdout
    key_file.write_bytes(bytes([key[0] ^ 1]) + key[1:])
    rejected = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert rejected.returncode == 2
    failure = json.loads(rejected.stderr)
    assert failure["state"] == "rejected" and failure["applied"] is False
    assert rejected.stdout == ""
    assert str(bundle) not in rejected.stderr and str(key_file) not in rejected.stderr
    assert bundle.read_bytes() == original
