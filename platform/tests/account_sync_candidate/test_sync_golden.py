"""Actual old-source contract oracle; no old backend executes."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest
from alcor_api.account_signals import DOMAINS


def test_old_typescript_sync_contract_golden():
    root = os.environ.get("ALCOR_SYNC_LEGACY_ROOT")
    if not root:
        pytest.skip("Explicit readonly legacy source is required for golden")
    area = Path(__file__).parent
    evidence = json.loads((area / "source-evidence.json").read_text())
    for name, expected in evidence["source_sha256"].items():
        assert hashlib.sha256((Path(root) / name).read_bytes()).hexdigest() == expected
    value = json.loads(subprocess.check_output(["node", str(area / "run_sync_golden.cjs"), root], text=True))
    assert value["discovery"] == {
        "version": 1, "path": "/api/v2/account-sync", "state_path": "/api/v2/app-state",
        "operation_path": "/api/v2/app-state/operations/{requestId}", "namespaces": ["watch", "fees"],
        "domains": list(DOMAINS), "interval_seconds": 15, "patch_only": True, "automatic_mutation_replay": False,
    }
    assert value["canonical"] == [
        "null", "true", "0", "9007199254740991", '"a\\"b"', '{"a":[null,true],"b":2}',
        '{"changes":[{"key":"[\\"notes\\",\\"US.A\\"]","revision":0,"value":"备注"}],"namespace":"watch","requestId":"00000000-0000-4000-8000-000000000001"}',
    ]
