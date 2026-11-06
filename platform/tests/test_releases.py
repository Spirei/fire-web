import json

from alcor_api import __version__
from alcor_api.config import ROOT
from alcor_api.release_version import software_version
from alcor_api.releases import release_records


def test_backend_version_uses_project_metadata_and_matches_web(tmp_path):
    assert __version__ == software_version() == json.loads((ROOT.parent / "package.json").read_text())["version"]
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "0.2.999"\n')
    assert software_version(tmp_path) == "0.2.999"


def test_shared_catalog_merges_duplicate_changes_and_sorts_numeric_versions(tmp_path):
    path = tmp_path / "releases.json"
    path.write_text(
        json.dumps(
            {
                "releases": [
                    {"version": "0.1.9", "date": "2026-10-30", "changes": ["First"]},
                    {"version": "0.1.10", "date": "2026-10-31", "changes": ["Next"]},
                    {"version": "0.1.9", "date": "2026-10-31", "changes": ["First", "Concurrent"]},
                ]
            }
        )
    )
    records = release_records(path)
    assert [r["version"] for r in records] == ["0.1.10", "0.1.9"]
    assert records[1] == {"version": "0.1.9", "date": "2026-10-31", "changes": ["First", "Concurrent"]}
