import hashlib
import io
import json
import tarfile
from contextlib import contextmanager
from uuid import uuid4

import pytest
from alcor_api.backup_stream_archive import DEFAULT_LIMITS, Blob, Limits, pack_archive, validate_archive
from alcor_api.backup_stream_codec import EncryptWriter, StreamFailure
from cryptography.fernet import Fernet


def base():
    return {"format": 2, "backup_id": str(uuid4()), "instance_id": str(uuid4()), "tables": {}, "schema": {}}


def entries(count=1):
    values = [
        Blob.memory("database.dump", b"synthetic dump"),
        Blob.memory("secrets/connections.key", Fernet.generate_key()),
    ]
    for n in range(count):
        raw = ("synthetic original " + str(n)).encode()
        values.append(Blob.memory("resource-media/" + hashlib.sha256(raw).hexdigest(), raw))
    return values


def archive(blobs=None, limits=DEFAULT_LIMITS):
    key = Fernet.generate_key()
    manifest = base()
    target = io.BytesIO()
    projected, count, sha = pack_archive(target, key, manifest, blobs or entries(), limits)
    return target.getvalue(), key, projected, count, sha


def validate(raw, key, manifest, limits=DEFAULT_LIMITS, **kw):
    return validate_archive(
        io.BytesIO(raw), key, manifest["backup_id"], manifest["instance_id"], limits, **kw
    )


def test_archive_roundtrip_sha_secret_cache_and_stream_extraction():
    blobs = entries(8)
    raw, key, manifest, count, sha = archive(blobs)
    assert count == len(raw) and sha == hashlib.sha256(raw).hexdigest()
    read, secrets = validate(raw, key, manifest)
    assert read == manifest and secrets == {"secrets/connections.key": blobs[1].opener().read()}
    output = {}

    @contextmanager
    def sink(name, info):
        stream = io.BytesIO()
        yield stream
        output[name] = stream.getvalue()

    assert validate(raw, key, manifest, sink_factory=sink)[0] == manifest
    assert output == {blob.name: blob.opener().read() for blob in blobs}


@pytest.mark.parametrize("case", ["budget", "objects", "duplicate", "path", "mismatch", "source_changed"])
def test_producer_refuses_invalid_source_or_limits(case):
    blobs = entries()
    limits = DEFAULT_LIMITS
    if case == "budget":
        limits = Limits(max_bytes=10)
    if case == "objects":
        limits = Limits(max_objects=2)
    if case == "duplicate":
        blobs.append(blobs[-1])
    if case == "path":
        blobs.append(Blob.memory("../outside", b"evil"))
    if case == "mismatch":
        blobs[-1] = Blob(blobs[-1].name, blobs[-1].size, "0" * 64, blobs[-1].opener)
    if case == "source_changed":
        blobs[-1] = Blob(blobs[-1].name, blobs[-1].size, blobs[-1].sha256, lambda: io.BytesIO(b"changed"))
    with pytest.raises((StreamFailure, OSError)):
        archive(blobs, limits)


def forged_archive(members, manifest=None):
    value = manifest or base()
    key = Fernet.generate_key()
    target = io.BytesIO()
    encoder = EncryptWriter(target, key, value["backup_id"], value["instance_id"], maximum=4 * 1024**2)
    with tarfile.open(fileobj=encoder, mode="w|gz") as tar:
        for name, raw, kind in members:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(raw)
            tar.addfile(item, io.BytesIO(raw))
    encoder.finish()
    return target.getvalue(), key, value


@pytest.mark.parametrize(
    "case",
    [
        "no_manifest",
        "duplicate",
        "path",
        "link",
        "missing_file",
        "wrong_digest",
        "oversized_pax",
        "sparse_pax",
    ],
)
def test_consumer_rejects_authenticated_but_invalid_archives(case):
    value = base()
    raw = b"synthetic"
    sha = hashlib.sha256(raw).hexdigest()
    value["files"] = {
        "database.dump": {"bytes": len(raw), "sha256": sha},
        "secrets/connections.key": {"bytes": len(raw), "sha256": sha},
    }
    prefix = [("manifest.json", json.dumps(value).encode(), tarfile.REGTYPE)]
    members = prefix + [
        ("database.dump", raw, tarfile.REGTYPE),
        ("secrets/connections.key", raw, tarfile.REGTYPE),
    ]
    if case == "no_manifest":
        members = members[1:]
    if case == "duplicate":
        members += members[-1:]
    if case == "path":
        members += [("../outside", raw, tarfile.REGTYPE)]
    if case == "link":
        members[-1] = ("secrets/connections.key", b"", tarfile.SYMTYPE)
    if case == "missing_file":
        members = members[:-1]
    if case == "wrong_digest":
        members[-1] = ("secrets/connections.key", b"corrupted", tarfile.REGTYPE)
    if case == "oversized_pax":
        members = [("pax", b"x" * 65537, tarfile.XHDTYPE)] + members
    if case == "sparse_pax":
        members = [("sparse", b"", tarfile.GNUTYPE_SPARSE)] + members
    raw, key, value = forged_archive(members, value)
    with pytest.raises(StreamFailure):
        validate(raw, key, value)


def test_5000_distinct_originals_have_bounded_manifest_and_no_payload_dictionary():
    raw, key, value, _count, _sha = archive(entries(5000))
    manifest, secrets = validate(raw, key, value)
    assert len(manifest["files"]) == 5002 and len(secrets) == 1
    assert len(json.dumps(manifest)) < 2 * 1024**2
