"""A bounded cycle called by the existing independent platform Worker."""

from .dividend_source_service import Sources, claim, step
from .dividend_sources import Target


def from_settings(db):
    # Operator-installed configuration only. HTTP source configuration cannot add targets.
    def current():
        return tuple(Target(**target) for target in getattr(db.settings, "dividend_source_targets", []))

    return Sources(db, current(), target_provider=current)


async def cycle(sources, worker_id, stop=None):
    task = await claim(sources.db, worker_id)
    if task is None:
        return {"id": None, "state": "idle"}
    # One invocation has a finite page budget; a stop leaves its original lease/UUID reclaimable.
    for _ in range(50):
        if stop is not None and stop.is_set():
            return {"id": str(task["id"]), "state": "stopping"}
        state = await step(sources, task)
        if state != "more":
            return {"id": str(task["id"]), "state": state}
    return {"id": str(task["id"]), "state": "yielded"}
