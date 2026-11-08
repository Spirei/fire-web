"""Existing source grants keep public bindings; explicit schemas bind new grants."""
import json
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import pytest

from alcor_api.source_authority import definition_hash
from alcor_api.source_registry import load_registry,RegistryError
from alcor_api.source_snapshot import SourceDefinition


def entry():
    return {'alias':'synthetic-source','instance':'synthetic-instance','kind':'postgres','owners':['synthetic-owner'],
            'timezone':'Asia/Shanghai','schemaHash':'1'*64,'locator':'host=source.example.invalid dbname=source user=reader',
            'expectedDatabase':'source','expectedDataDirectory':'/synthetic/pg','expectedRole':'reader',
            'expectedFileIdentity':None,'expectedDatasetIdentity':{'kind':'postgres','systemIdentifier':'12345','databaseOid':'678'}}


def write(tmp_path,version,item):
    directory=tmp_path/'private';directory.mkdir(mode=0o700,exist_ok=True)
    path=directory/'sources.json';instance=uuid4()
    path.write_text(json.dumps({'version':version,'platformInstance':str(instance),'sources':[item]}))
    path.chmod(0o600)
    return SimpleNamespace(legacy_source_registry_path=path,instance_id=instance)


def test_public_registry_binding_is_unchanged_and_v3_requires_schema(tmp_path):
    old=load_registry(write(tmp_path,2,entry()))['synthetic-source']
    assert old.schema_name=='public' and 'schema' not in old.public_binding()
    new=load_registry(write(tmp_path,3,entry()|{'schemaName':'ledger'}))['synthetic-source']
    assert new.schema_name=='ledger' and new.public_binding()['schema']=='ledger'
    assert definition_hash(new)!=definition_hash(old)
    assert definition_hash(replace(new,schema_name='public'))==definition_hash(old)
    with pytest.raises(RegistryError):load_registry(write(tmp_path,3,entry()))
    with pytest.raises(RegistryError):load_registry(write(tmp_path,2,entry()|{'schemaName':'ledger'}))
    with pytest.raises(RegistryError):load_registry(write(tmp_path,3,entry()|{'schemaName':'pg_catalog'}))
