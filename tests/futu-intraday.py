"""Execute the production RT_DATA bridge against a fake SDK, without opening OpenD."""
import importlib.util
import io
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', root / 'scripts/futu_quotes.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Frame:
    empty = False
    def iterrows(self):
        return enumerate([
            {'code': 'US.AAPU', 'time': '2026-10-12 09:30:00', 'cur_price': 45, 'volume': 1, 'is_blank': False},
            {'code': 'US.AAPU', 'time': '2026-10-12 09:31:00', 'cur_price': 46, 'volume': 2, 'is_blank': False},
            {'code': 'US.AAPU', 'time': '2026-10-12 09:32:00', 'cur_price': 99, 'volume': 1, 'is_blank': True},
            {'code': 'US.MSFT', 'time': '2026-10-12 09:33:00', 'cur_price': 999, 'volume': 1, 'is_blank': False},
            {'code': 'US.AAPU', 'time': '2026-10-13 01:30:00', 'cur_price': 100, 'volume': 1, 'is_blank': False},
        ])

class Context:
    last = None
    def __init__(self, **kwargs):
        Context.last = self
        self.closed = False
        self.options = []
    def subscribe(self, codes, subtypes, **kwargs):
        self.options.append(kwargs)
        return 0, None
    def get_rt_data(self, code):
        if code == 'US.BAD':
            raise RuntimeError('unsupported instrument')
        return 0, Frame()
    def close(self):
        self.closed = True

sdk = types.SimpleNamespace(OpenQuoteContext=Context, RET_OK=0,
    SubType=types.SimpleNamespace(RT_DATA='RT'), Session=types.SimpleNamespace(ALL='ALL'))
output = io.StringIO()
payload = {'cmd': 'intraday', 'items': [{'id': 'bad', 'market': 'US', 'code': 'BAD'}, {'id': 'review', 'market': 'US', 'code': 'AAPU'}]}
with patch.dict(sys.modules, {'futu': sdk}), patch('sys.stdin', io.StringIO(json.dumps(payload))), patch('sys.stdout', output):
    bridge.main()
data = json.loads(output.getvalue())
assert data['charts']['review']['date'] == '2026-10-12'
assert [p['price'] for p in data['charts']['review']['points']] == [45, 46]
assert 'bad' not in data['charts']
assert all(option == {'subscribe_push': False, 'session': 'ALL'} for option in Context.last.options)
assert Context.last.closed
print('PASS production RT_DATA bridge: actual fields, session, blank/wrong-security/overnight rejection, per-symbol failure and close (fake SDK only)')
