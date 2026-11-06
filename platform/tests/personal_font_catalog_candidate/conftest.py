from dataclasses import replace

import psycopg
import pytest_asyncio
from legacy_source.conftest import old_pg as base_old_pg
from personal_font_source_candidate.conftest import admin, app, base_settings, client, settings, source_file

__all__ = ["admin", "app", "base_old_pg", "base_settings", "client", "settings", "source_file"]
OTHER = "other-explicit-source-owner"


@pytest_asyncio.fixture
async def old_pg(base_old_pg, pg):
    async with await psycopg.AsyncConnection.connect(
        pg.get_uri(database=base_old_pg.expected_database)
    ) as conn:
        await conn.execute("INSERT INTO users(id) VALUES(%s)", (OTHER,))
    return replace(base_old_pg, owners=(*base_old_pg.owners, OTHER))
