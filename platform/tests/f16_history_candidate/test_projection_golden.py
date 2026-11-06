"""Execute actual old pure functions; no old server, provider or database."""
import hashlib
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from alcor_api.legacy_chart_series import minute_points
from alcor_api.legacy_history_bars import aggregate_observed_days


def test_actual_old_chart_normalizer_and_period_aggregation():
    root = os.environ.get('ALCOR_MARKET_LEGACY_ROOT')
    if not root:
        pytest.skip('Explicit read-only old source root required')
    here = Path(__file__).parent
    for name, sha in json.loads((here/'source-evidence.json').read_text()).items():
        assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest() == sha
    stamps = [datetime.fromisoformat(value) for value in ['2026-10-20T20:00:00-04:00','2026-10-21T04:00:00-04:00','2026-10-21T09:30:00-04:00']]
    now = datetime.fromisoformat('2026-10-21T15:00:00+00:00')
    rows = [{'d':'2026-10-20','o':10,'h':12,'l':9,'c':11,'v':0}, {'d':'2026-10-21','o':11,'h':13,'l':10,'c':12,'v':5}]
    raw = subprocess.check_output(['node',str(here/'old_projection.cjs'),root],input=json.dumps({'stamps':[value.timestamp() for value in stamps],'prices':[10,11,12],'now':now.timestamp()*1000,'rows':rows}),text=True)
    old = json.loads(raw)
    policy = SimpleNamespace(source='synthetic',source_version='v1')
    query = SimpleNamespace(market='US',session='ALL')
    facts = [{'source_time':stamp,'contents':{'at':stamp.isoformat(),'c':str(10+i),'source':'synthetic','sourceVersion':'v1','currency':'USD','session':'ALL'}} for i,stamp in enumerate(stamps)]
    points = minute_points(facts,policy,query,1,now)
    assert [{key:point[key] for key in ('date','time','price')} for point in points] == old['series']['points']
    assert aggregate_observed_days(rows,'week') == old['period']
