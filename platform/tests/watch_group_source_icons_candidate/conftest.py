import json

import psycopg
import pytest_asyncio
from watch_group_import_candidate.conftest import admin, app, base_pg, base_settings, client, old_pg, settings

__all__ = ['admin', 'app', 'base_pg', 'base_settings', 'client', 'old_pg', 'settings']

SVG = b'<?xml version="1.0"?><!-- by TradingView --><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'


@pytest_asyncio.fixture(autouse=True)
async def icon_source(settings, old_pg, pg, tmp_path):
    settings.file_root = tmp_path/'platform-files'
    root = tmp_path/'old-group-root'; root.mkdir(mode=0o700)
    group = root/old_pg.owners[0]/'old-custom'; group.mkdir(parents=True)
    path = group/'source.svg'; path.write_bytes(SVG); path.chmod(0o444)
    directory = tmp_path/'icon-registration'; directory.mkdir(mode=0o700)
    file = directory/'icons.json'; file.write_text(json.dumps({'version': 1, 'platformInstance': str(settings.instance_id), 'roots': [{'sourceAlias': old_pg.alias, 'root': str(root), 'rootIdentity': [root.stat().st_dev, root.stat().st_ino], 'layout': 'watch-group-owned-upload-v1'}]})); file.chmod(0o600)
    settings.watch_group_icon_import_registry_path = file
    reference = '/uploads/asset/group/'+old_pg.owners[0]+'/old-custom/source.svg'
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE watch_groups SET icon=%s WHERE id='old-custom'", (reference,))
    return root, path, reference
