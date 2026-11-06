"""Historical dividend expectations from one canonical ledger and explicit source coverage.

No cash/position writes. Owner confirmation is evidence of a claim, not proof of
official source completeness; a configured verifier must establish closed coverage.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, time
from decimal import Decimal, localcontext
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from alcor_api.dividend_announcements import NORMALIZER_VERSION
from alcor_api.trading import exact

DOMAINS = frozenset({"fills", "splits", "transfers", "non_cash_changes"})
_CALENDAR_DATE = re.compile(r"^\d{4}[./-]\d{1,2}[./-]\d{1,2}$")


@dataclass(frozen=True)
class CoverageVerification:
    document_sha256: str
    assurance: str
    quantity_domains: frozenset[str]
    identity: tuple[str, str, str, str, str]
    announcement_binding: tuple[str | None, ...]


def source_binding(announcement):
    return (
        str(announcement["revision"]),
        announcement["raw_sha256"],
        announcement["source"],
        announcement["source_event_id"],
        announcement["source_revision"],
        announcement["market"],
        announcement["code"],
        announcement["market_timezone"],
        announcement["date_basis"],
        announcement["normalizer_version"],
        announcement["captured_at"].isoformat(),
    )


def text(value, limit=160):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= limit
        or value.strip() != value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("invalid evidence identifier")
    return value


def ident(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("invalid evidence UUID")
    return value


def timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("explicit timestamp required")
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None or stamp.utcoffset() is None:
        raise ValueError("timestamp timezone required")
    return stamp.astimezone(UTC)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def coverage_input(raw):
    required = {
        "requestId",
        "recordId",
        "recordRevision",
        "sourceReference",
        "document",
        "confirmedOwnerEvidence",
    }
    if not isinstance(raw, dict) or raw.keys() != required or raw["confirmedOwnerEvidence"] is not True:
        raise ValueError("invalid history evidence")
    ident(raw["requestId"])
    text(raw["recordId"])
    text(raw["sourceReference"])
    if type(raw["recordRevision"]) is not int or raw["recordRevision"] < 1:
        raise ValueError("record version required")
    document = raw["document"]
    if not isinstance(document, str) or not 1 <= len(document.encode()) <= 65536:
        raise ValueError("bounded source document required")
    manifest = json.loads(document)
    fields = {
        "coverageFrom",
        "coverageThrough",
        "openingQuantity",
        "tradeIds",
        "splits",
        "transfers",
        "nonCashChanges",
        "ownerId",
        "recordId",
        "accountId",
        "market",
        "code",
    }
    if not isinstance(manifest, dict) or manifest.keys() != fields:
        raise ValueError("all quantity domains must be explicit")
    for key in ("ownerId", "recordId", "accountId", "market", "code"):
        text(manifest[key])
    start, end = timestamp(manifest["coverageFrom"]), timestamp(manifest["coverageThrough"])
    if start > end:
        raise ValueError("invalid coverage range")
    exact(manifest["openingQuantity"])
    trade_ids = manifest["tradeIds"]
    if not isinstance(trade_ids, list) or len(trade_ids) > 1000 or len(set(trade_ids)) != len(trade_ids):
        raise ValueError("invalid source trade references")
    for trade_id in trade_ids:
        ident(trade_id)
    for key in ("splits", "transfers", "nonCashChanges"):
        if not isinstance(manifest[key], list) or len(manifest[key]) > 100:
            raise ValueError("quantity event evidence must be a bounded explicit list")
    canonical(manifest)
    return {
        **raw,
        "manifest": manifest,
        "documentSha256": hashlib.sha256(document.encode()).hexdigest(),
    }


def replay(announcement, record, trades, coverage, verification, now):
    normalized = announcement["normalized"]
    result = {
        "announcementRevision": str(announcement["revision"]),
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "accountId": record["broker_account_id"],
        "accountKind": record["account_kind"],
        "coverageRevision": str(coverage["revision"]) if coverage else None,
        "status": "unknown",
        "quantity": None,
        "expectedGross": None,
        "currency": normalized["currency"],
        "cutoff": None,
        "cashReceipt": False,
        "cashWritten": False,
        "evidenceAssurance": "owner_confirmed" if coverage else None,
        "announcementAssurance": "owner_supplied",
        "reason": None,
        "dueState": "unknown",
    }

    def unknown(reason, status="unknown"):
        return {**result, "status": status, "reason": reason}

    if (
        announcement["normalizer_version"] != NORMALIZER_VERSION
        or normalized.get("normalizerVersion") != NORMALIZER_VERSION
    ):
        return unknown("normalizer_revision_not_supported")
    if record["market"] != announcement["market"] or record["code"] != announcement["code"]:
        return unknown("security_identity_mismatch")
    if len(trades) > 10000:
        return unknown("history_replay_budget_exceeded")
    if normalized["kind"] == "special":
        return unknown("non_cash_or_mixed_requires_quantity_action_review", "non_cash")
    if normalized["kind"] != "cash" or normalized["amount"] is None:
        return unknown(normalized.get("amountUnknownReason") or "cash_rate_unknown")
    if not normalized["exDate"]:
        return unknown("ex_date_unknown")
    if announcement["date_basis"] != "source_calendar_date" or not _CALENDAR_DATE.fullmatch(
        str(normalized["sourceDates"].get("ex_date") or "")
    ):
        return unknown("source_ex_date_contract_unknown")
    if not announcement["market_timezone"]:
        return unknown("market_timezone_unknown")
    try:
        zone = ZoneInfo(announcement["market_timezone"])
    except ZoneInfoNotFoundError:
        return unknown("market_timezone_unknown")
    cutoff = datetime.combine(datetime.fromisoformat(normalized["exDate"]).date(), time.min, zone).astimezone(
        UTC
    )
    result["cutoff"] = cutoff.isoformat()
    if now < cutoff:
        return unknown("ex_date_not_reached", "pending")
    if not coverage:
        return unknown("history_coverage_missing")
    if not isinstance(verification, CoverageVerification):
        return unknown("history_source_completeness_unverified")
    if (
        verification.document_sha256 != coverage["document_sha256"]
        or verification.quantity_domains != DOMAINS
        or verification.assurance not in {"source_verified", "synthetic_verified_fixture"}
        or verification.identity
        != (
            record["owner_id"],
            record["id"],
            record["broker_account_id"],
            record["market"],
            record["code"],
        )
    ):
        return unknown("history_source_completeness_unverified")
    result["evidenceAssurance"] = verification.assurance
    if verification.announcement_binding != source_binding(announcement):
        return unknown("announcement_source_unverified")
    result["announcementAssurance"] = verification.assurance
    payload = coverage["input_payload"]
    manifest = payload["manifest"]
    if (
        tuple(manifest[key] for key in ("ownerId", "recordId", "accountId", "market", "code"))
        != verification.identity
    ):
        return unknown("history_source_identity_mismatch")
    start, end = timestamp(manifest["coverageFrom"]), timestamp(manifest["coverageThrough"])
    if not start <= cutoff <= end or end > now:
        return unknown("history_interval_does_not_cover_ex_date")
    if any(manifest[key] for key in ("splits", "transfers", "nonCashChanges")):
        return unknown("quantity_actions_not_in_canonical_ledger")
    if (
        record["broker_account_id"] != coverage["account_id"]
        or record["account_kind"] != coverage["account_kind"]
        or record["market"] != coverage["market"]
        or record["code"] != coverage["code"]
    ):
        return unknown("history_source_identity_mismatch")
    if record["history_state"] == "unknown" or record["qty"] is None:
        return unknown("canonical_position_history_unknown")
    if record["holding_source"] != "manual" or record["account_kind"] not in {"real", "simulated"}:
        return unknown("canonical_account_authority_unsupported")
    ordered = sorted(trades, key=lambda row: row["before_record_revision"])
    previous, previous_revision, previous_quantity, previous_time = None, 0, Decimal(0), None
    for row in ordered:
        if (
            row["owner_id"] != record["owner_id"]
            or row["record_id"] != record["id"]
            or row["account_id"] != record["broker_account_id"]
            or row["account_kind"] != record["account_kind"]
            or row["previous_trade_id"] != previous
            or row["before_record_revision"] <= previous_revision
            or row["before_quantity"] != previous_quantity
            or previous_time is not None
            and row["occurred_at"] < previous_time
        ):
            return unknown("canonical_trade_lineage_incomplete")
        with localcontext() as context:
            context.prec = 128
            expected = row["before_quantity"]
            if row["side"] == "buy":
                expected += row["quantity"]
            elif row["side"] == "sell":
                expected -= row["quantity"]
            elif row["side"] != "dividend":
                return unknown("canonical_quantity_action_unsupported")
        if expected < 0 or expected != row["after_quantity"]:
            return unknown("canonical_quantity_lineage_inconsistent")
        previous, previous_revision = row["id"], row["before_record_revision"]
        previous_quantity, previous_time = row["after_quantity"], row["occurred_at"]
    if (
        previous != record["trade_tip_id"]
        or previous_quantity != record["qty"]
        or not ordered
        and record["history_state"] != "empty"
    ):
        return unknown("canonical_projection_does_not_match_history")
    covered = [row for row in ordered if start <= row["occurred_at"] <= end]
    if set(manifest["tradeIds"]) != {str(row["id"]) for row in covered}:
        return unknown("source_trade_set_does_not_match_canonical_ledger")
    opening = Decimal(manifest["openingQuantity"])
    canonical_opening = next(
        (row["after_quantity"] for row in reversed(ordered) if row["occurred_at"] < start), Decimal(0)
    )
    if canonical_opening != opening:
        return unknown("source_opening_does_not_match_canonical_ledger")
    quantity = opening
    for row in covered:
        if row["occurred_at"] >= cutoff:
            break
        quantity = row["after_quantity"]
    with localcontext() as context:
        context.prec = 128
        gross = quantity * Decimal(normalized["amount"])
    local_today = now.astimezone(zone).date().isoformat()
    pay_date = normalized["payDate"]
    result.update(
        {
            "status": "no_entitlement" if quantity == 0 else "zero_cash" if gross == 0 else "expected",
            "quantity": format(quantity, "f"),
            "expectedGross": format(gross, "f"),
            "reason": None,
            "dueState": "unknown"
            if not pay_date
            else "not_due"
            if pay_date > local_today
            else "due_unconfirmed",
        }
    )
    if quantity > 0 and gross > 0 and result["dueState"] == "due_unconfirmed":
        result["status"] = "receivable"
    return result
