import asyncio

import pytest
from resource_test_support import resource_files  # noqa:F401
from alcor_api.security import COOKIE


@pytest.mark.parametrize(
    "action,content_type,fragment",
    [
        ("folders", "application/json", b'{"requestId":'),
        (
            "files",
            "multipart/form-data; boundary=synthetic",
            b'--synthetic\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n\r\npartial',
        ),
    ],
)
async def test_disconnected_resource_body_is_handled_without_server_error_or_receipt(
    app, client, admin, settings, action, content_type, fragment
):
    messages = [{"type": "http.request", "body": fragment, "more_body": True}, {"type": "http.disconnect"}]
    never = asyncio.Event()
    sent = []

    async def receive():
        if messages:
            return messages.pop(0)
        await never.wait()

    async def send(message):
        sent.append(message)

    path = "/api/resource-library/" + action
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 12345),
        "headers": [
            (b"host", b"testserver"),
            (b"origin", b"http://testserver"),
            (b"content-type", content_type.encode()),
            (b"cookie", f"{COOKIE}={client.cookies[COOKIE]}".encode()),
            (b"x-csrf-token", client.headers["x-csrf-token"].encode()),
        ],
    }
    await asyncio.wait_for(app(scope, receive, send), 5)
    starts = [item for item in sent if item["type"] == "http.response.start"]
    assert starts and starts[0]["status"] == 499
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_operation_receipts")).fetchone())[
            "n"
        ] == 0
    assert not settings.file_root.exists()
