#!/usr/bin/env python3
"""Bounded pure-source audit of the Git index. Never print credential values.
This is an artifact/known-pattern check, not a claim of a complete security audit.
"""
import json
import hashlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Fixed, visually reviewed public application artwork, pinned to exact source bytes.
PUBLIC_IMAGE_HASHES = {'apps/web/public/assets/brands/redis.png': '4cb3225f0df2d608be12cde655b32a8081e9360c195509b91e991b883b42f965', 'backend/alcor_api/data/public_site_passkey.png': 'e5723a1d7676ac90c023c3a7ba3ac89de89b11fc507314e6a1e3de175a00f337'}
FORBIDDEN_DIRS = {'.local','.venv','node_modules','dist','__pycache__','.pytest_cache','.ruff_cache','test-results','playwright-report'}
LOCAL_ONLY = {'AGENTS.md','CODEX_START_PROMPT.md','IMPLEMENTATION_STATUS.md','source-publication.json','SHA256SUMS.txt','tools/validate-plan.py','tools/refresh-source-inventory.py','tools/build-migration-register.py'}
FORBIDDEN_SUFFIXES = {'.db','.sqlite','.sqlite3','.log','.key','.pem','.p12','.pfx','.ipa','.zip','.tgz','.bak','.pyc','.tsbuildinfo'}
PRIVATE_CONTEXT = [re.compile(rb'/volume[0-9]+/'), re.compile(rb'/(?:Users|Volumes)/[A-Za-z0-9._-]+/'), re.compile(rb'\b192[.]168[.]28[.][0-9]{1,3}\b')]
PATTERNS = [
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    re.compile(rb'\bAKIA[A-Z0-9]{16}\b'),
    re.compile(rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b'),
]

def git(*args):
    return subprocess.check_output(['git',*args],cwd=ROOT)


def audit():
    if Path(git('rev-parse','--show-toplevel').decode().strip()).resolve()!=ROOT:
        raise RuntimeError('wrong repository root')
    entries=git('ls-files','--stage','-z').split(b'\0')
    issues=[];files=0;total=0
    for entry in entries:
        if not entry:continue
        metadata,raw_name=entry.split(b'\t',1)
        mode,sha,stage=metadata.decode().split()
        name=raw_name.decode();path=Path(name)
        if stage!='0' or mode not in {'100644','100755'}:
            issues.append({'file':name,'reason':'unmerged or non-regular file'});continue
        if (path.parts[0] in {'docs','data','uploads','backups','exports','release-artifacts'} or set(path.parts)&FORBIDDEN_DIRS or path.suffix.lower() in FORBIDDEN_SUFFIXES
            or (path.name.startswith('.env') and path.name!='.env.example')
            or (path.name.endswith('.env') and not path.name.endswith('.env.example'))
            or path.name in {'runner.config.json','pending.json','pgpass','.DS_Store'}
            or name in LOCAL_ONLY):
            issues.append({'file':name,'reason':'local/private/generated artifact'});continue
        data=git('cat-file','blob',sha);files+=1;total+=len(data)
        if len(data)>2*1024*1024:issues.append({'file':name,'reason':'unexpected large source file'})
        if any(p.search(data) for p in PRIVATE_CONTEXT):issues.append({'file':name,'reason':'personal machine path or network context; value withheld'})
        if any(p.search(data) for p in PATTERNS):issues.append({'file':name,'reason':'possible credential; value withheld'})
        if b'\x00' in data and PUBLIC_IMAGE_HASHES.get(name)!=hashlib.sha256(data).hexdigest():
            issues.append({'file':name,'reason':'unexpected binary'})
    return {'kind':'staged-pure-source-and-known-credential-patterns','passed':not issues,'files':files,'bytes':total,'issues':issues,'complete_security_audit':False}

if __name__=='__main__':
    result=audit();print(json.dumps(result,ensure_ascii=False,indent=2));raise SystemExit(0 if result['passed'] else 1)
