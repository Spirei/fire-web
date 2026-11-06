"""A submitted original task completes after its HTTP client closes, using real controlled HTTP."""

import asyncio
import json
import subprocess
import sys
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from alcor_api.price_alert_quotes import ControlledHttpQuotes
from alcor_api.price_alert_runtime import discovery
from psycopg.conninfo import conninfo_to_dict

from .test_price_alerts import HERE, alert_settings, alerts, upsert

__all__ = ["alert_settings", "alerts"]


async def test_independent_worker_without_submitting_client_has_real_quote_and_matching_heartbeat(alerts):
    client, app, service, clock = alerts
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies=client.cookies,
        headers={"origin": "http://testserver", "x-csrf-token": client.headers["x-csrf-token"]},
    ) as submitting:
        await upsert(submitting)
    clock[0] += timedelta(seconds=1)
    owner = (await client.get("/api/price-alerts")).json()["accountId"]
    body = json.dumps(
        {
            "owner": owner,
            "account": owner,
            "sourceIdentity": "platform",
            "market": "US",
            "code": "AAPL",
            "currency": "USD",
            "price": "340.000001",
            "cached": False,
            "time": clock[0].isoformat(),
            "session": "REGULAR",
        }
    ).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/quote"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_port
        url = f"http://127.0.0.1:{port}/quote"
        approval = {
            "target": ["http", "127.0.0.1", port, "/quote"],
            "addresses": ["127.0.0.1"],
            "allow_plaintext": True,
        }
        service.reader = ControlledHttpQuotes(url, approval, lambda: clock[0])
        assert not (await discovery(service, 2))["monitoring_available"]
        settings = app.state.db.settings
        async with app.state.db.connection() as conn:
            directory = (await (await conn.execute("SHOW data_directory")).fetchone())["data_directory"]
            queued = await (await conn.execute("SELECT id FROM tasks WHERE kind='alerts.monitor'")).fetchone()
        raw = {
            "database_url": settings.database_url.get_secret_value(),
            "instance_id": str(settings.instance_id),
            "migration_dir": str(settings.migration_dir),
            "data_directory": directory,
            "database_name": conninfo_to_dict(settings.database_url.get_secret_value())["dbname"],
            "quote_url": url,
            "approval": approval,
            "fixture_now": clock[0].isoformat(),
        }
        result = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(HERE / "run_alert_worker.py")],
            input=json.dumps(raw),
            text=True,
            capture_output=True,
            timeout=20,
        )
        assert result.returncode == 0, "Private Worker failed; private PG identity withheld"
        value = json.loads(result.stdout)
        assert value["taskId"] == str(queued["id"]) and value["state"] == "triggered"
        assert (await discovery(service, 2))["monitoring_available"]
        snapshot = (await client.get("/api/price-alerts")).json()
        assert len(snapshot["events"]) == 1
        identifier = snapshot["events"][0]["deliveries"][0]["id"]
        receipt = await client.get("/api/notifications/deliveries/" + identifier)
        assert (
            receipt.status_code == 200
            and receipt.json()["state"] == "delivered"
            and not receipt.json()["willRetryAutomatically"]
        )
        async with app.state.db.connection() as conn:
            await conn.execute(
                "UPDATE price_alert_worker_heartbeats SET source_fingerprint='different-source-revision'"
            )
        assert not (await discovery(service, 2))["monitoring_available"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
