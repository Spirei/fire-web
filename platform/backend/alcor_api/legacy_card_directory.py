"""Read only the explicit public card manifest and its allowlisted original files."""
import asyncio
import time
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import HTTPException

from .card_catalog_contract import manifest_value, public_manifest
from .legacy_asset_directory import LegacyAssetDirectory, EXTENSIONS, SVG_LIMIT


def card_id(path):
    return 'card:' + path.removeprefix('/uploads/cards/')


class LegacyCardDirectory(LegacyAssetDirectory):
    def load(self):
        if self.cached is not None and time.monotonic() < self.until:
            return self.cached
        try:
            raw = self.read_parts(['cards', 'manifest.json'], 2 * 1024 * 1024)
        except HTTPException as exc:
            if exc.status_code == 404:
                self.cached = []
                self.until = time.monotonic() + 5
                return []
            raise
        try:
            manifest = public_manifest(manifest_value(raw.decode('utf-8-sig'), '运行目录原始卡面清单')['manifest'])
        except (UnicodeError, ValueError):
            raise HTTPException(503, '原始卡面清单无法读取') from None
        rows = []; seen = set()
        for region in manifest['regions']:
            for bank in region.get('banks', []):
                for card in bank.get('cards', []):
                    file = card.get('file', '')
                    if not isinstance(file, str):
                        continue
                    path = 'cards/' + unquote(file)
                    parts = path.split('/')
                    if not self.safe_parts(parts) or path in seen:
                        continue
                    seen.add(path)
                    url = '/uploads/' + quote(path, safe='/')
                    rows.append({'id': 'card:' + file, 'type': 'card', 'market': (region.get('label', '') or 'OTHER').upper(), 'code': card.get('name', '').upper(), 'name': card.get('name', '') or Path(path).stem, 'bank': bank.get('name', ''), 'region': region.get('label', ''), 'relativePath': path, 'legacyPath': url, 'originalImageUrl': url, 'coverage': 'runtime-card-manifest', 'readOnly': True, 'customized': False})
        self.cached = rows; self.until = time.monotonic() + 5
        return rows

    @staticmethod
    def safe_parts(parts):
        return (2 <= len(parts) <= 12 and parts[0] == 'cards'
                and all(p and not p.startswith('.') and '\\' not in p and not any(ord(c) < 32 for c in p) for p in parts)
                and Path(parts[-1]).suffix.lower()[1:] in EXTENSIONS)

    def path_parts(self, path):
        if not any(row['relativePath'] == path for row in self.load()):
            raise HTTPException(404, '卡面未在公开清单中登记')
        return path.split('/')

    def read_original(self, path):
        parts = self.path_parts(path)
        return self.read_parts(parts, SVG_LIMIT if Path(path).suffix.lower() == '.svg' else 20 * 1024 * 1024)

    async def entries(self):
        async with self.lock:
            return await asyncio.to_thread(self.load)

    async def find(self, aid):
        return next((row for row in await self.entries() if row['id'] == aid or aid.startswith('card:') and unquote(aid[5:]) == unquote(row['originalImageUrl'])), None)
