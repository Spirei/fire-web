"""Static deployment artifact checks only; never invokes Docker, a database or a live .env."""

import argparse
import json
import re
import tomllib
from pathlib import Path

import yaml


def validate(root):
    errors = []

    def check(ok, message):
        if not ok:
            errors.append(message)

    compose = yaml.safe_load((root / "deploy/compose.yaml").read_text())
    app = compose["services"]["app"]
    docker = (root / "deploy/Dockerfile").read_text()
    env = dict(
        line.split("=", 1)
        for line in (root / "deploy/app.env.example").read_text().splitlines()
        if line and not line.startswith("#")
    )
    release = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    for path in ["package.json", "apps/web/package.json"]:
        check(
            json.loads((root / path).read_text())["version"] == release, "package version mismatch: " + path
        )
    check(
        json.loads((root / "contracts/platform.openapi.json").read_text())["info"]["version"] == release,
        "OpenAPI version does not match release; regenerate the API contract",
    )
    backend_version = (root / "backend/alcor_api/__init__.py").read_text()
    check(
        (
            "from .release_version import software_version" in backend_version
            and "__version__ = software_version()" in backend_version
            and (root / "backend/alcor_api/release_version.py").is_file()
        )
        or re.search(
            r'__version__\s*=\s*"' + re.escape(release) + '"',
            backend_version,
        )
        is not None,
        "backend version mismatch",
    )
    check(set(compose["services"]) == {"app"}, "only the application belongs in this project")
    check(
        "ALCOR_APP_IMAGE:?" in app["image"] and "build" not in app,
        "runtime must use an explicitly configured latest image",
    )
    check(
        app.get("read_only") is True and app.get("cap_drop") == ["ALL"],
        "container permissions are incomplete",
    )
    check(all(port.startswith("127.0.0.1:") for port in app["ports"]), "application must bind to loopback")
    check(compose["networks"]["existing-data"]["external"] is True, "data network must already exist")
    mounts = app.get("volumes", [])
    check(
        {v["target"] for v in mounts}
        == {"/var/lib/alcor/state", "/var/lib/alcor/backups", "/var/lib/alcor/backup-key", "/var/lib/alcor/uploads", "/var/lib/alcor/assets"},
        "private persistent mounts are incomplete",
    )
    check(
        all(v.get("bind", {}).get("create_host_path") is False for v in mounts),
        "host directories must be explicitly prepared",
    )
    check(any(v["target"]=="/var/lib/alcor/assets" and v.get("read_only") is True for v in mounts), "assets must be read-only")
    check(len({v["source"] for v in mounts}) == 5, "archive and recovery keys must have independent sources")
    check(
        "ALCOR_CONNECTION_SECRET_DIR" in env and "ALCOR_BACKUP_SECRET_DIR" in env,
        "secret directory configuration is incomplete",
    )
    check(env.get("ALCOR_RESTORE_TARGETS") == "[]", "no implicit restore destination is allowed")
    check(
        "USER 10001:10001" in docker and "postgresql-client-$PG_MAJOR" in docker,
        "runtime user or database tools missing",
    )
    check(
        "contracts/releases.json" in docker and "contracts/api-capabilities.json" in docker and "deploy/entrypoint.py" in docker,
        "version history or private storage validation missing",
    )
    check("docker.sock" not in str(app) and "privileged" not in app, "unsafe application capability")
    for name in ["compose.yaml", "compose.synology.yaml"]:
        template = yaml.safe_load((root / "deploy" / name).read_text())
        target = template["services"]["app"]
        check(set(template["services"]) == {"app"}, "Watchtower must be independently managed")
        check("docker.sock" not in str(target), "Docker socket must not enter app")
        check(target["labels"].get("com.centurylinklabs.watchtower.enable") == "true", "application update label missing")
        check(target["labels"].get("com.centurylinklabs.watchtower.scope") == "alcor-api", "application update scope missing")
        check("ALCOR_RELEASE_VERSION" not in template["services"]["app"].get("environment", {}), "version must come from the image")
    check(
        "migrate" not in (root / "deploy/entrypoint.py").read_text()
        and "migrate" not in app.get("command", ""),
        "startup must not run database migrations",
    )
    versions = json.loads((root / "contracts/releases.json").read_text())["releases"]
    check(
        versions[0]["version"] == release and len({r["version"] for r in versions}) == len(versions),
        "release history is inconsistent",
    )
    hostenv = (root / "deploy/compose.env.example").read_text()
    check(
        ":latest" in hostenv and "ALCOR_RELEASE_VERSION=" not in hostenv
        and "ALCOR_RELEASE_VERSION=${APP_VERSION}" in docker and "ALCOR_SOURCE_REVISION=${SOURCE_REVISION}" in docker,
        "latest deployment must obtain its actual version and revision from the image",
    )
    return {
        "kind": "static-deployment-artifacts-only",
        "version": release,
        "passed": not errors,
        "docker_executed": False,
        "production_accessed": False,
        "issues": errors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    result = validate(args.root.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
