from uuid import uuid4

import pytest_asyncio
from test_legacy_devices import bearer, grant, register


@pytest_asyncio.fixture(autouse=True)
async def resource_files(settings, tmp_path):
    settings.file_root = tmp_path / "resource-files"
    # No directory is created until the first authorized mutation.


async def setup(client, db, version=0):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read resources.read resources.write")
    read = await grant(db, uid, "portfolio.read resources.read")
    base = f"/api/v{version}/resource-library" if version else "/api/client/resource-library"
    return uid, pair, read, base


def unwrap(response, version):
    return response.json()["data"] if version else response.json()


async def upload(client, base, pair, filename="original.txt", raw=b"original\r\n", rid=None, **extra):
    data = {"requestId": rid or str(uuid4()), "category": "components", "name": filename, **extra}
    response = await client.post(
        base + "/files",
        headers=bearer(pair),
        data=data,
        files={"file": ("transport.bin", raw, "application/octet-stream")},
    )
    return response, data["requestId"]
