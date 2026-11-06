async def test_oversize_stream_rejected_without_echo(client):
    async def body():
        yield b'{"login":"sample","password":"'
        for _ in range(80):
            yield b"x" * 1024
        yield b'"}'

    response = await client.post(
        "/api/session/login", content=body(), headers={"content-type": "application/json"}
    )
    assert response.status_code == 413
    assert "x" * 100 not in response.text
