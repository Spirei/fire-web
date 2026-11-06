"""Bounded, read-only projection of a local migration publisher heartbeat."""
import json
import re
import stat
from datetime import UTC, datetime
from pathlib import Path

LIMIT = 16384
FIELDS = {'schema_version','state','feature_id','step','summary','updated_at','sequence','source_commit'}
STATES = {'working','verifying','waiting','blocked','idle','complete'}
PRIVATE = re.compile(r'(?:[/\\]|https?:|密码|密钥|令牌|凭据|堆栈|traceback|\b(?:password|passwd|secret|token|credential|authorization|cookie|bearer|api[_ -]?key)\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)',re.IGNORECASE)


def unknown():
    return {'schemaVersion':1,'state':'unknown','featureId':None,'step':None,'summary':None,
            'updatedAt':None,'sequence':None,'stale':False}


def text(value, maximum):
    return (isinstance(value,str) and len(value)<=maximum
            and not any(ord(c)<32 or ord(c)==127 for c in value) and not PRIVATE.search(value))


def sanitize(raw, *, now=None):
    if (not isinstance(raw,dict) or set(raw)-FIELDS or raw.get('schema_version')!=1
            or type(raw.get('schema_version')) is not int or raw.get('state') not in STATES
            or not isinstance(raw.get('feature_id'),str) or not re.fullmatch(r'F\d{2}',raw['feature_id'])
            or not text(raw.get('step'),120) or not text(raw.get('summary'),300)
            or type(raw.get('sequence')) is not int or not 0<=raw['sequence']<=9007199254740991):
        return unknown()
    commit = raw.get('source_commit')
    if commit is not None and (not isinstance(commit,str) or not re.fullmatch(r'[0-9a-f]{7,40}',commit)):
        return unknown()
    try:
        stamp = datetime.fromisoformat(raw['updated_at'])
        if stamp.tzinfo is None: return unknown()
        age = ((now or datetime.now(UTC))-stamp).total_seconds()
        if age < -5: return unknown()
    except (KeyError,TypeError,ValueError,OverflowError):
        return unknown()
    result = {'schemaVersion':1,'state':raw['state'],'featureId':raw['feature_id'],
              'step':raw['step'],'summary':raw['summary'],'updatedAt':raw['updated_at'],
              'sequence':raw['sequence'],'stale':age>120}
    if commit is not None: result['sourceCommit']=commit
    return result


def read_work_status(inventory_file):
    try:
        path = Path(inventory_file).parent/'migration-work-status.json'
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode): return unknown()
        with path.open('rb') as stream:
            data=stream.read(LIMIT+1)
        if len(data)>LIMIT: return unknown()
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result: raise ValueError('duplicate_field')
                result[key]=value
            return result
        return sanitize(json.loads(data,object_pairs_hook=unique))
    except (OSError,ValueError,TypeError,UnicodeError,RecursionError):
        return unknown()
