import io
import struct
from uuid import uuid4

import pytest
from alcor_api.backup_stream_codec import CHUNK, MAGIC, DecryptReader, EncryptWriter, StreamFailure
from cryptography.fernet import Fernet


def bundle(raw=b"synthetic payload" * 10000, chunk=1024):
    target = io.BytesIO()
    key = Fernet.generate_key()
    bid = str(uuid4())
    owner = str(uuid4())
    writer = EncryptWriter(target, key, bid, owner, maximum=10 * CHUNK, chunk_size=chunk)
    for offset in range(0, len(raw), 177):
        writer.write(raw[offset : offset + 177])
    count, sha = writer.finish()
    return target.getvalue(), key, bid, owner, count, sha


def decode(raw, key, bid, owner, maximum=10 * CHUNK):
    source = DecryptReader(io.BytesIO(raw), key, bid, owner, maximum=maximum)
    result = bytearray()
    while chunk := source.read(333):
        result.extend(chunk)
    source.finish()
    return bytes(result)


def frames(raw):
    offset = len(MAGIC) + 4 + struct.unpack("!I", raw[len(MAGIC) : len(MAGIC) + 4])[0]
    header = raw[:offset]
    parts = []
    while offset < len(raw):
        size = struct.unpack("!I", raw[offset : offset + 4])[0] + 20
        parts.append(raw[offset : offset + size])
        offset += size
    return header, parts


def test_partial_writes_and_small_reads_preserve_every_byte_and_cipher_hash():
    import hashlib

    raw = bytes(range(256)) * 1000
    encrypted, key, bid, owner, count, sha = bundle(raw)
    assert count == len(encrypted) and sha == hashlib.sha256(encrypted).hexdigest()
    assert decode(encrypted, key, bid, owner) == raw
    with pytest.raises(StreamFailure):
        decode(encrypted, key, bid, owner, maximum=100)


@pytest.mark.parametrize(
    "mutation",
    [
        "truncate_header",
        "truncate_record",
        "drop_final",
        "reorder",
        "duplicate",
        "alter_byte",
        "append",
        "wrong_id",
        "wrong_source",
        "wrong_key",
        "oversize_frame",
    ],
)
def test_every_tamper_or_missing_final_is_rejected(mutation):
    raw, key, bid, owner, _count, _sha = bundle()
    head, parts = frames(raw)
    if mutation == "truncate_header":
        raw = raw[:8]
    if mutation == "truncate_record":
        raw = raw[:-23]
    if mutation == "drop_final":
        raw = head + b"".join(parts[:-1])
    if mutation == "reorder":
        raw = head + parts[1] + parts[0] + b"".join(parts[2:])
    if mutation == "duplicate":
        raw = head + parts[0] + b"".join(parts)
    if mutation == "alter_byte":
        raw = raw[:-25] + bytes([raw[-25] ^ 1]) + raw[-24:]
    if mutation == "append":
        raw += b"extra"
    if mutation == "wrong_id":
        bid = str(uuid4())
    if mutation == "wrong_source":
        owner = str(uuid4())
    if mutation == "wrong_key":
        key = Fernet.generate_key()
    if mutation == "oversize_frame":
        raw = head + struct.pack("!I", CHUNK * 8) + parts[0][4:] + b"".join(parts[1:])
    with pytest.raises(StreamFailure):
        decode(raw, key, bid, owner)


def test_empty_final_authenticates_header_and_unbounded_read_is_forbidden():
    raw, key, bid, owner, _count, _sha = bundle(b"")
    assert decode(raw, key, bid, owner) == b""
    reader = DecryptReader(io.BytesIO(raw), key, bid, owner, maximum=100)
    with pytest.raises(StreamFailure):
        reader.read()
    changed = raw.replace(b"gzip-tar", b"gzip-TAK", 1)
    with pytest.raises(StreamFailure):
        decode(changed, key, bid, owner)
