"""Canonical public release records, including shared development catalogs."""

import json
import re
from pathlib import Path

from .config import ROOT


def release_records(path: Path = ROOT / "contracts/releases.json") -> list[dict]:
    records = {}
    for item in json.loads(path.read_text())["releases"]:
        version = item["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("invalid release version")
        if not isinstance(item["changes"], list) or not all(isinstance(v, str) for v in item["changes"]):
            raise ValueError("invalid release changes")
        record = records.setdefault(version, {"version": version, "date": item["date"], "changes": []})
        record["date"] = max(record["date"], item["date"])
        for change in item["changes"]:
            if change not in record["changes"]:
                record["changes"].append(change)
    return sorted(records.values(), key=lambda r: tuple(map(int, r["version"].split("."))), reverse=True)
