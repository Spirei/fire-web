"""The offline tool reads a separate private key, never a command-line secret."""
import base64
import importlib.util
import os
from pathlib import Path

import pytest


@pytest.fixture
def command():
    source = Path(__file__).resolve().parents[2] / "tools/verify-unified-export.py"
    spec = importlib.util.spec_from_file_location("unified_export_offline_command", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_separate_raw_and_canonical_encoded_keys_are_read_without_rewriting(command, tmp_path):
    key = bytes(range(32))
    for number, raw in enumerate((key, base64.urlsafe_b64encode(key).rstrip(b"="), base64.urlsafe_b64encode(key).rstrip(b"=") + b"\n")):
        source = tmp_path / str(number)
        source.write_bytes(raw)
        source.chmod(0o600)
        assert command.read_key(source) == key
        assert source.read_bytes() == raw


def test_unsafe_permissions_symlinks_and_bad_encodings_never_reach_verification(command, tmp_path, capsys, monkeypatch):
    source = tmp_path / "key"
    source.write_bytes(bytes(range(32)))
    source.chmod(0o644)
    monkeypatch.setattr(command, "verify", lambda *args: pytest.fail("unsafe key reached verifier"))
    arguments = [str(tmp_path / "bundle"), "--key-file", str(source)]
    assert command.main(arguments) == 2
    assert '"code": "key_file_unsafe"' in capsys.readouterr().err
    source.chmod(0o600)
    link = tmp_path / "link"
    link.symlink_to(source)
    assert command.main([str(tmp_path / "bundle"), "--key-file", str(link)]) == 2
    assert '"code": "file_unavailable"' in capsys.readouterr().err
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo, 0o600)
    assert command.main([str(tmp_path / "bundle"), "--key-file", str(fifo)]) == 2
    assert '"code": "key_file_unsafe"' in capsys.readouterr().err
    for raw in (b"", b"x" * 31, b"!" * 43, b"A" * 42 + b"B", b"A" * 100):
        source.write_bytes(raw)
        assert command.main(arguments) == 2
        output = capsys.readouterr()
        assert '"code": "key_file_invalid"' in output.err
        assert output.out == ""
        assert str(source) not in output.err
