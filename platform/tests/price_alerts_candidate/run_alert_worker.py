"""One controlled independent Worker cycle; refuses every target except the proven private PG/socket."""

import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

for key in list(os.environ):
    if key.startswith("ALCOR_"):
        del os.environ[key]
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(HERE)]

from alcor_api.config import Settings
from alcor_api.db import Database
from alcor_api.price_alert_contract import timestamp
from alcor_api.price_alert_quotes import ControlledHttpQuotes
from alcor_api.price_alert_service import Alerts
from alcor_api.price_alert_worker import cycle


async def main(raw):
    settings = Settings(
        database_url=raw["database_url"],
        instance_id=raw["instance_id"],
        migration_dir=raw["migration_dir"],
        public_origin="http://testserver",
        environment="test",
        redis_url=None,
        connection_targets=[],
        backup_dir=None,
        backup_secret_dir=None,
        connection_secret_dir=None,
        restore_targets=[],
        file_root=None,
    )
    db = Database(settings)
    await db.open()
    try:
        async with db.connection() as conn:
            assert (await (await conn.execute("SELECT current_database() AS name")).fetchone())[
                "name"
            ] == raw["database_name"]
            assert raw["database_name"].startswith("alcor_test_")
            directory = Path(
                (await (await conn.execute("SHOW data_directory")).fetchone())["data_directory"]
            ).resolve()
            assert directory == Path(raw["data_directory"]).resolve() and directory.name.startswith(
                "alcor-test-"
            )
            assert (await (await conn.execute("SHOW listen_addresses")).fetchone())["listen_addresses"] == ""
        from urllib.parse import urlsplit

        target = urlsplit(raw["quote_url"])
        assert target.hostname == "127.0.0.1" and target.scheme == "http" and target.path == "/quote"
        assert raw["approval"]["addresses"] == ["127.0.0.1"]
        now = timestamp(raw["fixture_now"])
        reader = ControlledHttpQuotes(raw["quote_url"], raw["approval"], lambda: now)
        service = Alerts(db, reader, lambda: now)
        result = await cycle(service, uuid4())
        print(json.dumps(result))
    finally:
        await db.close()


asyncio.run(main(json.load(sys.stdin)))
