import importlib.util
import json
import subprocess

from alcor_api.config import ROOT


def scanner(tmp_path):
    spec=importlib.util.spec_from_file_location('source_audit',ROOT/'tools/audit-source.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.ROOT=tmp_path
    subprocess.run(['git','init','-q',str(tmp_path)],check=True)
    (tmp_path/'README.md').write_text('Clean synthetic source')
    subprocess.run(['git','add','.'],cwd=tmp_path,check=True)
    return module


def stage(tmp_path,name,data):
    path=tmp_path/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    subprocess.run(['git','add','-f',name],cwd=tmp_path,check=True)


def test_source_gate_rejects_local_data_even_when_force_staged(tmp_path):
    audit=scanner(tmp_path)
    assert audit.audit()['passed']
    stage(tmp_path,'.env',b'EXAMPLE=synthetic-only')
    stage(tmp_path,'data/account.json',b'{}')
    result=audit.audit()
    assert not result['passed'] and {i['file'] for i in result['issues']}=={'.env','data/account.json'}


def test_source_gate_reports_known_credential_patterns_without_echoing_values(tmp_path):
    audit=scanner(tmp_path)
    synthetic=('ghp_'+'Z'*36).encode()
    stage(tmp_path,'accidental.txt',synthetic)
    result=audit.audit()
    assert not result['passed'] and synthetic.decode() not in json.dumps(result)


def test_source_gate_rejects_local_screenshots_and_unexpected_binaries(tmp_path):
    audit=scanner(tmp_path)
    stage(tmp_path,'docs/qa/screenshot.png',b'synthetic')
    stage(tmp_path,'unexpected.bin',b'\x00synthetic')
    result=audit.audit()
    assert not result['passed'] and len(result['issues'])==2


def test_source_gate_rejects_discussion_notes_and_machine_context(tmp_path):
    audit=scanner(tmp_path)
    stage(tmp_path,'CODEX_START_PROMPT.md',b'local discussion only')
    stage(tmp_path,'README.md',('/'+'Users/'+'Example/private-project').encode())
    stage(tmp_path,'fixture.ts',('192.168.'+'28.41').encode())
    stage(tmp_path,'compose.yaml',('/vol'+'ume1/docker/'+'personal-state').encode())
    result=audit.audit()
    assert not result['passed'] and len(result['issues'])==4
    assert 'Example/private-project' not in json.dumps(result)
