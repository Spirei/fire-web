"""Frozen legacy card text rules and bounded, explicitly supplied metadata snapshots."""

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

from .card_preferences import JS_WHITESPACE, js_text, sqlite_text

CARD_TYPES = ('借记卡', '信用卡', '预付卡', '签账卡', '取现卡', '交通卡', '礼品卡', '虚拟卡', '其他')
CURRENCY_SCOPES = ('single', 'dual', 'multi', 'unknown')
MANIFEST_LIMIT = 2 * 1024 * 1024


@lru_cache(maxsize=1)
def han_map():
    return json.loads((Path(__file__).parent / 'data' / 'card-han-simplified.json').read_text())


def search_key(value):
    translated = ''.join(han_map().get(char, char) for char in value)
    return ''.join(char for char in translated if char not in JS_WHITESPACE).lower()


def clean(value, maximum):
    return js_text(value).strip(JS_WHITESPACE).encode('utf-16-le', errors='surrogatepass')[:maximum * 2].decode('utf-16-le', errors='surrogatepass')


def custom_input(raw):
    if not isinstance(raw, (dict, list)):
        raise HTTPException(400, '无效请求')
    raw = raw if isinstance(raw, dict) else {}
    value = {key: clean(raw.get(key), maximum) for key, maximum in (
        ('name', 60), ('bank', 60), ('region', 24), ('type', 12), ('brand', 24), ('level', 24), ('image', 300), ('currencyScope', 12),
    )}
    value['type'] = value['type'] if value['type'] in CARD_TYPES else '其他'
    value['currencyScope'] = value['currencyScope'].lower() if value['currencyScope'].lower() in CURRENCY_SCOPES else ''
    if not value['name']:
        raise HTTPException(400, '请填写卡名')
    if not value['bank']:
        raise HTTPException(400, '请填写银行')
    if not value['image'].startswith('/uploads/'):
        raise HTTPException(400, '请先上传卡面图片')
    return value


def key_of(card):
    return search_key(card['name']) + '@' + search_key(card['bank'])


def public_metadata(value, depth=0):
    if depth > 24:
        raise HTTPException(400, '卡面清单层级超过上限')
    if isinstance(value, dict):
        private_fields = {'password', 'passwordhash', 'token', 'accesstoken', 'refreshtoken', 'secret', 'privatekey', 'cvv', 'cardnumber', 'accounts', 'holdings', 'amounts', 'balances', 'orders', 'transactions', 'users'}
        for key, item in value.items():
            if key.replace('_', '').replace('-', '').lower() in private_fields:
                raise HTTPException(400, '卡面清单包含不支持的私人数据字段')
            public_metadata(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            public_metadata(item, depth + 1)
    elif isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(400, '卡面清单包含无效数值')


def manifest_value(text, source_label):
    if not isinstance(text, str):
        raise HTTPException(400, '卡面清单JSON无效')
    try:
        encoded = text.encode('utf-8')
    except UnicodeError:
        raise HTTPException(400, '卡面清单必须是UTF-8文本') from None
    if len(encoded) > MANIFEST_LIMIT:
        raise HTTPException(400, '卡面清单超过大小上限')
    if not isinstance(source_label, str) or not 1 <= len(source_label.strip()) <= 120 or any(ord(c) < 32 for c in source_label):
        raise HTTPException(400, '来源名称无效')
    try:
        def invalid(_):
            raise ValueError()
        value = json.loads(text.lstrip('\ufeff'), parse_constant=invalid)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, '卡面清单JSON无效') from None
    if not isinstance(value, dict) or not isinstance(value.get('regions'), list):
        raise HTTPException(400, '卡面清单缺少完整regions数组')
    public_metadata(value)
    keys = set()
    count = 0
    for region in value['regions']:
        if not isinstance(region, dict) or not isinstance(region.get('banks', []), list):
            raise HTTPException(400, '卡面地区结构无效')
        for bank in region.get('banks', []):
            if not isinstance(bank, dict) or not isinstance(bank.get('cards', []), list):
                raise HTTPException(400, '银行清单结构无效')
            for card in bank.get('cards', []):
                if not isinstance(card, dict):
                    raise HTTPException(400, '卡面记录结构无效')
                count += 1
                if count > 20000:
                    raise HTTPException(400, '卡面清单条目超过上限')
                if card.get('name'):
                    keys.add(search_key(js_text(card['name'])) + '@' + search_key(js_text(bank.get('name'))))
    # JSONB has no isolated UTF-16/NUL representation: source metadata uses safe JSON encoding at persistence.
    return {'manifest': value, 'sha256': hashlib.sha256(encoded).hexdigest(),
            'sourceLabel': source_label.strip(), 'cardCount': count, 'nameKeys': keys}


def sqlite_metadata(value):
    return {key: sqlite_text(item) for key, item in value.items()}


def public_manifest(value):
    """Only established card-directory fields become shared; raw/unknown source data stays admin-only."""
    def text_fields(raw, names):
        return {key: raw[key] for key in names if isinstance(raw.get(key), str)}

    def projected_card(raw, faces=True):
        result = text_fields(raw, ('name', 'type', 'sourceType', 'brand', 'level', 'nameEn'))
        for field in ('file', 'url'):
            item = raw.get(field)
            if not isinstance(item, str) or not item or any(char in item for char in ('\\', '\x00', '?', '#')) or '..' in item:
                continue
            if field == 'url' and not item.startswith('/uploads/'):
                continue
            if field == 'file' and (':' in item or item.startswith('/') and not item.startswith('/uploads/')):
                continue
            result[field] = item
        bins = raw.get('bins')
        if isinstance(bins, list):
            result['bins'] = [item for item in bins if isinstance(item, str) and item.isascii() and item.isdecimal() and len(item) in (6, 8)]
        if faces and isinstance(raw.get('faces'), list):
            result['faces'] = [projected_card(face, faces=False) for face in raw['faces'] if isinstance(face, dict)]
        return result

    regions = []
    for region in value.get('regions', []):
        banks = []
        for bank in region.get('banks', []):
            banks.append(dict(text_fields(bank, ('name', 'englishName', 'country')), cards=[projected_card(card) for card in bank.get('cards', [])]))
        regions.append(dict(text_fields(region, ('label',)), banks=banks))
    return {'regions': regions, 'typeOrder': [item for item in value.get('typeOrder', []) if item in CARD_TYPES] if isinstance(value.get('typeOrder', []), list) else []}
