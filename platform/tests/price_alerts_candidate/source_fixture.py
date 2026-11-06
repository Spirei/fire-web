import json
from uuid import uuid4

from alcor_api.dividend_chain_tasks import claim, execute


def announcement(**changes):
    data = {
        "requestId": str(uuid4()),
        "source": "futu",
        "market": "US",
        "code": "AAPL",
        "sourceEventId": "isolated-source-event-001",
        "sourceRevision": "source-v1",
        "capturedAt": "2026-01-04T00:00:00Z",
        "marketTimezone": "America/New_York",
        "dateBasis": "source_calendar_date",
        "expectedPreviousRevision": None,
        "raw": {
            "statement": "每10股派息2USD",
            "ex_date": "2026-01-03",
            "dividend_payable_date": "2026-01-10",
            "pub_date": "2025-12-25",
        },
        **changes,
    }
    if "sourceBytes" not in changes:
        data["sourceBytes"] = json.dumps(data["raw"], separators=(",", ":"), ensure_ascii=False)
    return data

async def queue(client, kind, data, request_id=None):
    response = await client.post(
        "/api/dividends/announcements/tasks",
        json={
            "request_id": request_id or str(uuid4()),
            "kind": kind,
            "data": data,
        },
    )
    assert response.status_code == 202, response.text
    return response.json()

async def run_one(app, verifier=None):
    task = await claim(app.state.db, uuid4())
    assert task is not None
    assert await execute(app.state.db, task, verifier)
    async with app.state.db.connection() as conn:
        return await (await conn.execute("SELECT * FROM tasks WHERE id=%s", (task["id"],))).fetchone()

async def ingest(client, app, data=None):
    data = data or announcement()
    queued = await queue(client, "dividends.source.import", data)
    task = await run_one(app)
    assert str(task["id"]) == queued["id"] and task["status"] == "succeeded", task
    return task["result"]["value"]
