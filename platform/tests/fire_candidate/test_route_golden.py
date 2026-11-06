"""Original v1/v2 route bodies and native PG adapters retain their envelopes."""
import json
import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from test_fire_planning import token


async def test_original_native_route_success_shapes_match_pg(client, admin, db):
    root=os.environ.get('ALCOR_FIRE_LEGACY_ROOT')
    if not root:pytest.skip('Explicit readonly legacy source required')
    proof=json.loads(Path(__file__).with_name('source-evidence.json').read_text())
    for name,expected_hash in proof['source_sha256'].items():
        assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==expected_hash
    actions=[{'version':v,'method':method,**({'body':{'fire':{'target':value,'baseCurrency':'USD'}}} if method=='PUT' else {})} for v,value in ((1,120),(2,240)) for method in ('GET','PUT','GET')]
    expected=json.loads(subprocess.run(['node',str(Path(__file__).with_name('old-routes.cjs'))],input=json.dumps(actions),text=True,capture_output=True,check=True,timeout=15).stdout)
    headers=await token(db,admin,'portfolio.read portfolio.write')
    for action,want in zip(actions,expected,strict=True):
        response=await client.request(action['method'],f"/api/v{action['version']}/fire-settings",headers=headers,**({'json':action['body']} if action['method']=='PUT' else {}))
        assert response.status_code==want['status']
        assert response.json()==want['body']
