import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

for key in tuple(os.environ):
    if key.startswith('ALCOR_'):del os.environ[key]
from alcor_api.config import Settings
from alcor_api.db import Database
from alcor_api.market_alert_reader import SharedQuotes, project_alert_demands
from alcor_api.market_authority import Authority, Policy
from alcor_api.market_calendar import Calendars
from alcor_api.market_contract import source_time
from alcor_api.market_transport import Transport
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.price_alert_service import Alerts
from alcor_api.price_alert_worker import claim as claim_alert
from alcor_api.price_alert_worker import execute as execute_alert


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
        policy = Policy(**raw["policy"])
        assert policy.fixture and policy.source == "controlled_market"
        now = source_time(raw["fixture_now"], "UTC")
        authority = Authority(db, (policy,), clock=lambda: now)
        transport = Transport(db, controlled_http={policy.id: (raw["source_url"], raw["approval"])})
        await project_alert_demands(authority)
        await schedule(authority)
        task = await claim(db, uuid4(), kind="market.latest")
        assert task
        market_state = await execute(authority, task, transport)
        await Calendars(db).ensure_builtin()
        alerts = Alerts(db, SharedQuotes(authority), lambda: now)
        alert = await claim_alert(db, uuid4())
        assert alert
        state = await execute_alert(alerts, alert)
        print(
            json.dumps(
                {
                    "sourceTaskId": str(task["id"]),
                    "market": market_state,
                    "alertTaskId": str(alert["id"]),
                    "alert": state,
                }
            )
        )
    finally:
        await db.close()


asyncio.run(main(json.load(sys.stdin)))
