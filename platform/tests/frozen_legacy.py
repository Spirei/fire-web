"""Executed old source fixtures; optional external roots must match the captured bytes."""

import hashlib
import json
import os
from pathlib import Path


def source_root(variable, files):
    frozen = Path(__file__).parent / 'fixtures/legacy-source'
    manifest = json.loads((frozen / 'source-sha256.json').read_text())
    selected = Path(os.environ[variable]) if os.environ.get(variable) else frozen
    for name in files:
        assert hashlib.sha256((frozen / name).read_bytes()).hexdigest() == manifest[name], name
        assert hashlib.sha256((selected / name).read_bytes()).hexdigest() == manifest[name], name
    return selected
