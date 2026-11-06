import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import resource_import_fixtures as fixtures
from alcor_api.resource_import_registry import ResourceSourceError
from alcor_api.source_window import MigrationWindow
from resource_import_fixtures import DIGEST, OWNER, RAW, READY, authorize, snapshot

source = fixtures.source
settings = fixtures.settings
app = fixtures.app
client = fixtures.client
admin = fixtures.admin
P = "/api/resource-import"


def expire(settings, state="active"):
    doc = json.loads(settings.legacy_source_registry_path.read_text())
    now = datetime.now(UTC)
    for row in doc["sources"]:
        row["migrationWindow"] = MigrationWindow(
            now - timedelta(hours=2),
            now - timedelta(hours=1) if state == "active" else now + timedelta(hours=1),
            state,
        ).document()
    settings.legacy_source_registry_path.write_text(json.dumps(doc))


async def test_pg_sqlite_resource_expired_capture_and_original_bytes_never_touch_old_root_but_saved_history_reads(
    client, admin, source, settings, app
):
    consent = await authorize(client, admin, source)
    manifest, request = await snapshot(client, consent)
    before = (await client.get(P + "/manifests/" + manifest)).json()
    assert before["manifest"]["metadataComplete"]
    expire(settings)
    registered = app.state.resource_import.resources[source.definition.alias]
    # If source access happened first this renamed root would fail its identity check.
    original_root = source.root
    renamed = source.root.with_name(source.root.name + "-moved")
    source.root.rename(renamed)
    try:
        with pytest.raises(ResourceSourceError, match="expired"):
            registered.read_original(OWNER, READY, len(RAW), DIGEST)
        response = await client.post(
            P + "/authorizations/" + consent + "/snapshots",
            json={"requestId": str(uuid4()), "revision": 2},
        )
        assert response.status_code == 409 and "已到期" in response.text, response.text
        assert (await client.get(P + "/manifests/" + manifest)).json() == before
        assert (await client.get(P + "/operations/" + request)).json()["manifestId"] == manifest
        assert (await client.get(P + "/authorizations")).json()["items"][0]["migrationWindow"][
            "state"
        ] == "expired"
        # Operator revocation is the same shared source authority, not a second file grant.
        expire(settings, "revoked")
        with pytest.raises(ResourceSourceError, match="revoked"):
            registered.read_original(OWNER, READY, len(RAW), DIGEST)
    finally:
        renamed.rename(original_root)
