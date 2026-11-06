"""Offline verification over collected PG bytes; source proof never proves position history."""

from dataclasses import dataclass

from .dividend_chain import DividendChain
from .dividend_entitlements import DOMAINS, CoverageVerification, source_binding
from .dividend_source_service import jsonable
from .dividend_sources import canonical, digest, parse


@dataclass(frozen=True)
class HistoryVerification:
    """Only a separately installed historical statement verifier may issue this.

    This is not an HTTP input and the collector does not construct it. It must bind
    the actual document and identity and prove *all* quantity-change domains.
    """

    document_sha256: str
    identity: tuple
    domains: frozenset
    assurance: str


@dataclass(frozen=True)
class SourceVerification:
    announcement_binding: tuple
    assurance: str
    market_timezone: str
    date_contract: str
    event_identity: str = "content_observation_not_official_event_id"
    complete_history: bool = False


async def verify_announcement(conn, sources, announcement):
    """No I/O and no mutation. Reparse exact saved source page, not browser assertions."""
    rows = await (
        await conn.execute(
            """SELECT p.*,o.json_pointer,o.record_fingerprint,c.config,c.target_id,c.target_fingerprint,c.source
        FROM dividend_source_observations o JOIN dividend_source_pages p
        ON p.owner_id=o.owner_id AND p.task_id=o.task_id AND p.cursor=o.cursor
        JOIN dividend_source_scans s ON s.task_id=p.task_id
        JOIN dividend_source_configs c ON c.owner_id=s.owner_id AND c.revision=s.config_revision
        WHERE o.owner_id=%s AND o.announcement_revision=%s AND p.raw_sha256=%s ORDER BY p.received_at LIMIT 1""",
            (announcement["owner_id"], announcement["revision"], announcement["raw_sha256"]),
        )
    ).fetchone()
    if not rows:
        return None
    try:
        target = sources.target(rows["target_id"], rows["target_fingerprint"])
        raw = bytes(rows["raw_bytes"])
        if digest(raw) != rows["raw_sha256"] or raw.decode("utf-8") != announcement["raw_payload"]:
            return None
        page = parse(rows["source"], raw, rows["config"], rows["cursor"])
        item = next((item for item in page.records if item[0] == rows["json_pointer"]), None)
        if item is None or digest(canonical(item[1]).encode()) != rows["record_fingerprint"]:
            return None
        if canonical(jsonable(item[2])) != canonical(announcement["normalized"]):
            return None
        if (
            target.source != announcement["source"]
            or rows["config"]["market"] != announcement["market"]
            or rows["config"]["code"] != announcement["code"]
            or page.timezone != announcement["market_timezone"]
            or item[2]["normalizerVersion"] != announcement["normalizer_version"]
        ):
            return None
        # Only the Futu market-local date contract is supported by primary technical documentation.
        if (
            target.source != "futu"
            or not item[2].get("dateContractVerified")
            or rows["source_date_contract"] != "official_market_local_calendar_yyyy_mm_dd"
        ):
            return None
        if not target.fixture and rows["representation"] != "sdk_json_representation_not_wire_bytes":
            return None
        return SourceVerification(
            source_binding(announcement),
            "synthetic_verified_fixture" if target.fixture else "source_verified",
            page.timezone,
            rows["source_date_contract"],
        )
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def combine(history, source, coverage, announcement):
    """Two independent proofs; owner-confirmed booleans or a quote feed alone cannot suffice."""
    if (
        not isinstance(history, HistoryVerification)
        or not isinstance(source, SourceVerification)
        or history.domains != DOMAINS
        or history.document_sha256 != coverage["document_sha256"]
        or history.assurance not in {"source_verified", "synthetic_verified_fixture"}
        or source.announcement_binding != source_binding(announcement)
    ):
        return None
    assurance = (
        "synthetic_verified_fixture"
        if "synthetic_verified_fixture" in {history.assurance, source.assurance}
        else "source_verified"
    )
    return CoverageVerification(
        history.document_sha256, assurance, history.domains, history.identity, source.announcement_binding
    )


class SourceAwareChain(DividendChain):
    """Composes proven source observations with the frozen ledger replay, without changing it."""

    def __init__(self, db, sources, history_verifier=None):
        super().__init__(db)
        self.sources, self.history_verifier = sources, history_verifier

    async def _entitlement(self, conn, who, record_id, revision, coverage_revision):
        announcement = await self._announcement(conn, who, revision)
        source = await verify_announcement(conn, self.sources, announcement)

        def verifier(coverage, row):
            history = self.history_verifier(coverage) if self.history_verifier else None
            return combine(history, source, coverage, row)

        # Per-call immutable binding avoids changing a shared verifier across concurrent owners.
        service = DividendChain(self.db, verifier)
        value = await service._entitlement(conn, who, record_id, revision, coverage_revision)
        value["sourceObservationAssurance"] = source.assurance if source else "unverified"
        value["sourceEventIdentity"] = "content_observation_not_official_event_id"
        value["sourceCompletesPositionHistory"] = False
        value["sourceNonCashChanges"] = announcement["normalized"].get("nonCashChanges", [])
        value["quantityActionApplied"] = False
        return value
