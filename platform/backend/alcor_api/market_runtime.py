"""One platform Worker lane; default source/permission configuration is empty."""

import asyncio
import logging
from uuid import uuid4

from .dividend_sources import Target
from .market_alert_reader import SharedQuotes, project_alert_demands
from .market_authority import Authority, Policy
from .market_transport import Transport
from .market_worker import claim, execute, schedule


def from_settings(db, *, reuse_latest=False):
    def policies():
        return tuple(Policy(**raw) for raw in getattr(db.settings, "market_data_policies", []))

    def targets():
        return tuple(Target(**raw) for raw in getattr(db.settings, "dividend_source_targets", []))

    return Authority(db, policies(), policy_provider=policies), Transport(db, target_provider=targets, reuse_latest=reuse_latest)


def reader_from_settings(db):
    authority, _ = from_settings(db)
    return SharedQuotes(authority) if authority.policies else None


async def cycle(authority, transport, worker_id, *, history_turn=False):
    await project_alert_demands(authority)
    await schedule(authority)
    task = await claim(authority.db, worker_id, kind="market.history") if history_turn else None
    if task is None:task = await claim(authority.db, worker_id, kind="market.latest")
    if task is None:
        # One bounded historical page only when no current latest observation is due.
        task = await claim(authority.db, worker_id, kind="market.history")
    return {
        "taskId": str(task["id"]) if task else None,
        "state": await execute(authority, task, transport) if task else "idle",
    }


async def batch_cycle(authority, transport, worker_id, *, history_turn=False, maximum=20):
    """Lease a bounded set of independent reads; every result keeps its own proof."""
    if type(maximum) is not int or not 1 <= maximum <= 20:
        raise ValueError("market_worker_batch_invalid")
    await project_alert_demands(authority)
    await schedule(authority)
    tasks = []
    if history_turn:
        historical = await claim(authority.db, worker_id, kind="market.history")
        if historical:
            tasks.append(historical)
    while len(tasks) < maximum:
        latest = await claim(authority.db, worker_id, kind="market.latest")
        if latest is None:
            break
        tasks.append(latest)
    if not tasks:
        historical = await claim(authority.db, worker_id, kind="market.history")
        if historical:
            tasks.append(historical)
    # Gather all leased children before the next batch. A failed provider must
    # neither cancel unrelated securities nor leave unbounded orphan reads.
    outcomes = await asyncio.gather(
        *(execute(authority, task, transport) for task in tasks), return_exceptions=True,
    )
    if any(isinstance(outcome, BaseException) for outcome in outcomes):
        logging.getLogger("alcor.worker").warning("market_latest_batch_unavailable")
    return bool(tasks)


async def loop(db, stop, current=lambda: True):
    authority, transport = from_settings(db, reuse_latest=True)
    worker_id = uuid4()
    cycles=0
    try:
        while not stop.is_set():
            progressed = False
            if current():
                try:
                    progressed = await batch_cycle(authority, transport, worker_id,history_turn=cycles%4==3)
                    cycles+=1
                    from .public_market_worker import cycle as public_cycle
                    await public_cycle(db, worker_id)
                except Exception:  # noqa: BLE001 -- Keep source errors and credentials out of platform logs.
                    logging.getLogger("alcor.worker").warning("market_latest_cycle_unavailable")
            else:
                await transport.close()
            await transport.retire_idle()
            if progressed:
                await asyncio.sleep(0)
                continue
            try:
                await asyncio.wait_for(stop.wait(), timeout=1)
            except TimeoutError:
                pass
    finally:
        await transport.close()
