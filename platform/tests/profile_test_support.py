"""Explicit private media fixture for the profile integration modules only."""

import pytest


@pytest.fixture(autouse=True)
def private_profile_files(settings, tmp_path):
    if settings.file_root is None:
        settings.file_root = tmp_path / "profile-private-files"
