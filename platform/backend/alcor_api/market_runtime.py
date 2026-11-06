"""One platform Worker lane; default source/permission configuration is empty."""

import asyncio
import logging
from uuid import uuid4

from .dividend_sources import Target
from .market_alert_reader import SharedQuotes, project_alert_demands
from .market_authority import Authority, Policy
from .market_transport import Transport
from .market_worker import claim, execute, schedule


def from_settings(db):
    def policies():
        return tuple(Policy(**raw) for raw in getattr(db.settings, "market_data_policies", []))

    def targets():
        return tuple(Target(**raw) for raw in getattr(db.settings, "dividend_source_targets", []))

    return Authority(db, policies(), policy_provider=policies), Transport(db, target_provider=targets)


def reader_from_settings(db):
    authority, _ = from_settings(db)
    return SharedQuotes(authority) if authority.policies else None


async def cycle(authority, transport, worker_id):
    await project_alert_demands(authority)
    await schedule(authority)
    task = await claim(authority.db, worker_id, kind="market.latest")
    if task is None:
        # One bounded historical page only when no current latest observation is due.
        task = await claim(authority.db, worker_id, kind="market.history")
    return {
        "taskId": str(task["id"]) if task else None,
        "state": await execute(authority, task, transport) if task else "idle",
    }


async def loop(db, stop, current=lambda: True):
    authority, transport = from_settings(db)
    worker_id = uuid4()
    while not stop.is_set():
        if current():
            try:
                await cycle(authority, transport, worker_id)
                from .public_market_worker import cycle as public_cycle
                await public_cycle(db, worker_id)
            except Exception:  # noqa: BLE001 -- Keep source errors and credentials out of platform logs.
                logging.getLogger("alcor.worker").warning("market_latest_cycle_unavailable")
        try:
            await asyncio.wait_for(stop.wait(), timeout=1)
        except TimeoutError:
            pass
