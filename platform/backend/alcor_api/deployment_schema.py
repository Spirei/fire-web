"""Check a release against committed migration receipts before notifying the updater."""

import asyncio
import base64
import hashlib
import re


MIGRATIONS = "platform/migrations"
MIGRATION_NAME = re.compile(r"[0-9][A-Za-z0-9_.-]*\.sql")
GIT_SHA = re.compile(r"[a-f0-9]{40}")


def migration_files(directory):
    return {path.name: path.read_bytes() for path in directory.glob("*.sql")}


def migration_hash(files):
    fingerprint = hashlib.sha256()
    for name, content in sorted(files.items()):
        fingerprint.update(name.encode() + b"\0" + content + b"\0")
    return fingerprint.hexdigest()


def schema_hash(directory):
    return migration_hash(migration_files(directory))


def git_blob_id(content):
    header = f"blob {len(content)}\0".encode()
    return hashlib.sha1(header + content, usedforsecurity=False).hexdigest()


async def matches_release_schema(settings, release, applied, github_read):
    local_files = migration_files(settings.migration_dir)
    if release.schema_hash == migration_hash(local_files):
        return applied == {name: hashlib.sha256(body).hexdigest() for name, body in local_files.items()}
    if not applied.keys() > local_files.keys():
        # Deployment routes only admit the current schema or a verified superset.
        # The current files cannot prove compatibility with a different fingerprint.
        return False

    entries = await github_read(settings, f"/contents/{MIGRATIONS}?ref={release.revision}")
    if not isinstance(entries, list):
        raise ValueError("Invalid release migration directory")
    targets = {}
    for entry in entries:
        name = entry["name"]
        if not name.endswith(".sql"):
            continue
        sha = entry["sha"]
        if (not MIGRATION_NAME.fullmatch(name) or not GIT_SHA.fullmatch(sha)
                or entry["type"] != "file" or entry["path"] != f"{MIGRATIONS}/{name}" or name in targets):
            raise ValueError("Invalid release migration entry")
        targets[name] = sha
    if not targets or targets.keys() != applied.keys():
        return False

    async def contents(name, sha):
        local = local_files.get(name)
        if local is not None and git_blob_id(local) == sha:
            return local
        blob = await github_read(settings, f"/git/blobs/{sha}")
        if blob["encoding"] != "base64" or blob["sha"] != sha:
            raise ValueError("Invalid release migration blob")
        content = base64.b64decode("".join(blob["content"].split()), validate=True)
        if len(content) != blob["size"] or git_blob_id(content) != sha:
            raise ValueError("Release migration blob changed")
        return content

    files = {}
    batch = list(targets.items())
    for start in range(0, len(batch), 4):
        group = batch[start:start + 4]
        bodies = await asyncio.gather(*(contents(name, sha) for name, sha in group))
        files.update({name: body for (name, _), body in zip(group, bodies)})
    if migration_hash(files) != release.schema_hash:
        raise ValueError("Release fingerprint does not match its commit")
    return all(hashlib.sha256(body).hexdigest() == applied[name] for name, body in files.items())
