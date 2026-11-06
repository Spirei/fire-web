"""Operator-private watch metadata schema registration; no second source locator/window."""

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from .source_authority import definition_hash
from .source_snapshot import canonical, sha


class WatchSourceError(ValueError):
    pass


@dataclass(frozen=True)
class WatchSource:
    alias: str
    schema_hash: str

    def binding(self, definition):
        return sha(canonical({'sourceBinding':definition_hash(definition),'watchGroupSchema':self.schema_hash,'scope':'watch-group-metadata-v1'}))


def load_watch_sources(settings,source_registry):
    path=settings.watch_group_import_registry_path
    if path is None:return {}
    path=Path(path)
    try:
        info=path.lstat();parent=path.parent.lstat()
        if not path.is_absolute() or any(p.is_symlink() for p in (path,*path.parents)) or not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or stat.S_IMODE(parent.st_mode)!=0o700 or info.st_size>65536:raise ValueError()
        value=json.loads(path.read_bytes())
        if set(value)!={'version','platformInstance','watchGroups'} or value['version']!=1 or value['platformInstance']!=str(settings.instance_id) or not isinstance(value['watchGroups'],list) or not 1<=len(value['watchGroups'])<=8:raise ValueError()
        result={}
        for item in value['watchGroups']:
            if not isinstance(item,dict) or set(item)!={'sourceAlias','schemaHash'} or item['sourceAlias'] not in source_registry or item['sourceAlias'] in result or not isinstance(item['schemaHash'],str) or not re.fullmatch('[a-f0-9]{64}',item['schemaHash']):raise ValueError()
            result[item['sourceAlias']]=WatchSource(item['sourceAlias'],item['schemaHash'])
        return result
    except (OSError,ValueError,TypeError,KeyError):raise WatchSourceError('分组来源登记权限、身份或结构不匹配') from None
