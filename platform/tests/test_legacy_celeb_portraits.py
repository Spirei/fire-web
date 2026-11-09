"""Named portraits remain in uploads; no seeding or mutation of public originals."""
import hashlib
import io

from PIL import Image


async def test_existing_upload_portrait_is_served_with_empty_registry(client, settings, tmp_path):
    settings.public_upload_root = tmp_path / 'uploads'
    portraits = settings.public_upload_root / 'celebs'
    portraits.mkdir(parents=True)
    image = io.BytesIO()
    Image.new('RGB', (8, 8), 'green').save(image, format='PNG')
    raw = image.getvalue()
    original = portraits / 'example-custom.png'
    original.write_bytes(raw)
    for path in ['/api/celeb-portraits/example-custom.png', '/uploads/celebs/example-custom.png']:
        response = await client.get(path)
        assert response.status_code == 200, response.text
        assert response.headers['content-type'] == 'image/png'
        assert response.content == raw
    assert original.read_bytes() == raw
    digest = hashlib.sha256(raw).hexdigest()
    assert (await client.get('/api/celeb-portraits/example-custom.png?sha256='+digest)).status_code == 200
    assert (await client.get('/api/celeb-portraits/example-custom.png?sha256='+'0'*64)).status_code == 404
    secret = tmp_path / 'private.png'
    secret.write_bytes(raw)
    (portraits / 'linked.png').symlink_to(secret)
    for path in ['linked.png', 'missing.png', 'example-custom.png.exe', '../private.png']:
        assert (await client.get('/api/celeb-portraits/'+path)).status_code in (400,404)
