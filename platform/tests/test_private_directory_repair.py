import os
import stat
from types import SimpleNamespace

import pytest
from alcor_api.connections import Vault
from alcor_api.profile_media import ProfileMedia
from alcor_api.private_paths import owned_directory


def test_private_children_narrow_inherited_permissions_without_changing_shared_parent(tmp_path):
    parent = tmp_path/'shared';parent.mkdir(mode=0o755)
    root = parent/'profile-media';root.mkdir(mode=0o775)
    assert ProfileMedia(SimpleNamespace(file_root=parent)).root(True) == root
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(parent.stat().st_mode) == 0o755


def test_credentials_reuse_the_same_key_after_permission_repair(tmp_path):
    root = tmp_path/'credentials';root.mkdir(mode=0o755)
    vault = Vault(root);original = vault.key()
    key = root/'connections.key';key.chmod(0o644);root.chmod(0o775)
    assert vault.key() == original
    assert stat.S_IMODE(key.stat().st_mode) == 0o600
    assert stat.S_IMODE(root.stat().st_mode) == 0o700


def test_symlink_never_repaired_or_followed(tmp_path):
    target = tmp_path/'other';target.mkdir(mode=0o755)
    link = tmp_path/'link';link.symlink_to(target, target_is_directory=True)
    with pytest.raises(OSError):owned_directory(link)
    assert stat.S_IMODE(target.stat().st_mode) == 0o755
