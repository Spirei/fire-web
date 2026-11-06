"""Custom provider adapter: same observations/tasks/UUID authority."""

import hashlib
import json
import os
import stat
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from .connections import Vault
from .fx_provider_credentials import materialize
from .fx_provider_parser import parse, source_time
from .fx_provider_transport import fetch


def vault(db):
    directory = db.settings.connection_secret_dir
    if directory is not None:
        Vault(directory).key()  # Validate/create the parent with private permissions.
    return Vault(Path(directory) / "fx-providers" if directory else None)


def kind(identifier):
    return "fx-provider:" + str(identifier)


def existing_key(settings):
    """Read an existing key without creating a replacement for sealed credentials."""
    try:
        directory = Path(settings.connection_secret_dir) / "fx-providers"
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise ValueError()
        fd = os.open(directory / "connections.key", os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise ValueError()
            key = file.read(128)
            Fernet(key)
            return key
    except (OSError, ValueError, TypeError):
        raise HTTPException(503, "已保存供应商凭据密钥不可用") from None


def decrypt_existing(key, row):
    try:
        payload = json.loads(Fernet(key).decrypt(row["secret_cipher"].encode()))
        if payload["kind"] != kind(row["id"]) or payload["instance"] != str(row["credential_instance"]):
            raise ValueError()
        if not isinstance(payload["password"], str):
            raise TypeError()
        return payload["password"]
    except (InvalidToken, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(503, "已保存供应商凭据无法读取") from None


async def authorize_source(conn, db, revision):
    row = await (
        await conn.execute("SELECT * FROM fx_provider_revisions WHERE id=%s", (revision,))
    ).fetchone()
    config = row["config"]
    secret = decrypt_existing(existing_key(db.settings), row)
    approval = json.loads(secret)["approval"]
    if not any(
        target.get("target") == approval.get("target")
        and set(approval["addresses"]) <= set(target.get("addresses", []))
        and (not approval.get("allow_plaintext") or target.get("allow_plaintext") is True)
        for target in getattr(db.settings, "fx_provider_targets", [])
    ):
        raise ValueError("target_approval_revoked")
    return config,secret,approval


async def read(conn, db, revision, requester=None):
    config,secret,approval=await authorize_source(conn,db,revision)
    url, headers = materialize(config, secret)
    return await (requester or fetch)(url, approval, headers)


async def persist(conn, raw, received, identifier, revision):
    row = await (
        await conn.execute("SELECT config FROM fx_provider_revisions WHERE id=%s", (revision,))
    ).fetchone()
    config = row["config"]
    parsed = parse(raw, config.get("declared_base"))
    if len(parsed["usd_ratios"]) < 2:
        raise ValueError("quotes_missing")
    precision, observed = source_time(
        json.loads(raw, parse_float=Decimal), config.get("time_field"), config.get("time_precision")
    )
    observed_date = observed if precision == "date" else None
    instant = datetime.fromisoformat(observed) if precision == "instant" else None
    if (observed_date and observed_date > received.astimezone(UTC).date().isoformat()) or (
        instant and instant > received
    ):
        raise ValueError("future_source_time")
    normalized = {k: [str(v.numerator), str(v.denominator)] for k, v in parsed["usd_ratios"].items()}
    await conn.execute(
        "INSERT INTO fx_observations(id,provider,source_uri,base_currency,observation_date,received_at,original_bytes,raw_sha256,normalized_sha256,provider_revision,source_precision,source_instant) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            identifier,
            "custom",
            config["url"],
            "USD",
            observed_date,
            received,
            raw,
            hashlib.sha256(raw).hexdigest(),
            hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest(),
            revision,
            precision,
            instant,
        ),
    )
    for code, value in parsed["usd_ratios"].items():
        if code == "USD":
            continue
        with localcontext() as context:
            context.prec = 50
            display = Decimal(value.numerator) / Decimal(value.denominator)
        await conn.execute(
            "INSERT INTO fx_values(observation_id,currency,rate,numerator,denominator) VALUES(%s,%s,%s,%s,%s)",
            (identifier, code, display, value.numerator, value.denominator),
        )
    return identifier
