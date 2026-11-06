"""Read the backend version from project metadata rather than a second literal."""

import tomllib
from importlib.metadata import version
from pathlib import Path


def software_version(root: Path | None = None) -> str:
    metadata = (root or Path(__file__).resolve().parents[2]) / "pyproject.toml"
    if metadata.is_file():
        return tomllib.loads(metadata.read_text())["project"]["version"]
    return version("fire-platform")
