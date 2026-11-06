"""The smallest permitted actual pool cannot be held hostage by upload slots."""

import asyncio

import httpx
from alcor_api.main import create_app
from resource_test_support import setup, upload


async def test_actual_pool_size_one_two_uploads_do_not_wait_for_their_own_slot(settings, tmp_path):
    settings.pool_size = 1
    settings.pool_min_size = 0
    settings.file_root = tmp_path / "one-pool-files"
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        _uid, pair, _read, base = await setup(client, app.state.db)
        assert app.state.db.pool.max_size == 1
        responses = await asyncio.wait_for(
            asyncio.gather(
                *(upload(client, base, pair, f"parallel-{n}.txt", b"synthetic single pool") for n in range(2))
            ),
            5,
        )
        assert [r[0].status_code for r in responses] == [201, 201], [r[0].text for r in responses]
