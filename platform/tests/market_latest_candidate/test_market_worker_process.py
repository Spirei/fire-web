"""Source demand and F19 complete after the submitting client closes, with real loopback HTTP."""

import asyncio
import json
import subprocess
import sys
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from alcor_api.market_contract import Query, canonical
from price_alerts_candidate.test_price_alerts import upsert
from psycopg.conninfo import conninfo_to_dict

from .test_market_alerts import alert_settings, attach, market, market_settings
from .test_market_authority import HERE, read

__all__ = ["alert_settings", "market", "market_settings"]


async def test_independent_worker_source_pg_fact_f19_reader_after_submitting_client_closes(market):
    client, app, authority, _, revision = market
    await attach(app, authority)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies=client.cookies,
        headers={"origin": "http://testserver", "x-csrf-token": client.headers["x-csrf-token"]},
    ) as submitting:
        await upsert(submitting)
    policy = authority.policies[0]
    query = Query("latest", "US", "AAPL")
    body = canonical(
        {
            "query": asdict(query),
            "licenseRevision": policy.license_revision,
            "facts": [
                {
                    "at": "2026-10-20T14:00:00+00:00",
                    "price": "340.000001",
                    "currency": "USD",
                    "session": "REGULAR",
                    "cached": False,
                    "name": "Fixture",
                }
            ],
            "nextCursor": None,
        }
    ).encode()
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            assert self.path == "/market"
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
        settings = app.state.db.settings
        async with app.state.db.connection() as conn:
            directory = (await (await conn.execute("SHOW data_directory")).fetchone())["data_directory"]
        url = f"http://127.0.0.1:{server.server_port}/market"
        raw = {
            "database_url": settings.database_url.get_secret_value(),
            "instance_id": str(settings.instance_id),
            "migration_dir": str(settings.migration_dir),
            "data_directory": directory,
            "database_name": conninfo_to_dict(settings.database_url.get_secret_value())["dbname"],
            "policy": asdict(policy),
            "source_url": url,
            "approval": {
                "target": ["http", "127.0.0.1", server.server_port, "/market"],
                "addresses": ["127.0.0.1"],
                "allow_plaintext": True,
            },
            "fixture_now": "2026-10-20T14:00:01+00:00",
        }
        result = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(HERE / "run_market_worker.py")],
            input=json.dumps(raw),
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr[-2000:]
        receipt = json.loads(result.stdout)
        assert receipt["market"] == "observed" and receipt["alert"] == "triggered" and calls == ["/market"]
        data = (await read(client, revision)).json()
        assert len(data["facts"]) == 1
        assert len((await client.get("/api/price-alerts")).json()["events"]) == 1
        assert calls == ["/market"]
        async with app.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM market_streams")).fetchone())[
                "n"
            ] == 1
            assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries")).fetchone())[
                "n"
            ] == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
