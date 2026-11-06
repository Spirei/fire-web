#!/usr/bin/env python3
"""Build a project-local Redis for isolated development. Never install/start a system service."""

import hashlib
import io
import subprocess
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "7.4.12"
# Official redis/redis release tag; pinned archive hash (the release download host may deny access).
COMMIT = "f9bc2f89232fa3fc6147ee732309d2616117b85e"
SHA256 = "324ab63d55c607639b419f547b213c62ae39ff50e09870e450a11c272567b84f"


def main():
    target = ROOT / ".local/tooling"
    source = target / f"redis-{VERSION}"
    if (source / "src/redis-server").is_file():
        print("Project-local Redis already built.")
        return
    target.mkdir(parents=True, exist_ok=True)
    cached = target / f"redis-{VERSION}-github.tar.gz"
    archive = (
        cached.read_bytes()
        if cached.is_file()
        else urllib.request.urlopen(
            f"https://codeload.github.com/redis/redis/tar.gz/refs/tags/{VERSION}", timeout=30
        ).read()
    )
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise RuntimeError("Redis release checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        tar.extractall(target, filter="data")
    subprocess.run(
        ["make", "-j2", "BUILD_TLS=no", "MALLOC=libc"],
        cwd=source,
        check=True,
        stdout=(target / "redis-build.log").open("w"),
        stderr=subprocess.STDOUT,
    )
    print("Project-local Redis built; no system service installed.")


if __name__ == "__main__":
    main()
