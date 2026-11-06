"""Operator-only source registry. Credentials stay in this private local file."""

import json
import os
import re
import stat
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

from .source_snapshot import SourceDefinition
from .source_window import parse_window


class RegistryError(ValueError):pass


def load_registry(settings):
    path=getattr(settings,'legacy_source_registry_path',None)
    if path is None:return {}
    path=Path(path)
    try:
        metadata = path.stat()
        parent = path.parent.stat()
        if not path.is_absolute() or path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or stat.S_IMODE(metadata.st_mode)!=0o600 or parent.st_uid!=os.getuid() or stat.S_IMODE(parent.st_mode)!=0o700 or metadata.st_size>65536:raise RegistryError()
        value=json.loads(path.read_bytes())
        if (
            set(value) != {"version", "platformInstance", "sources"}
            or type(value["version"]) is not int
            or value["version"] not in (1, 2)
            or UUID(value["platformInstance"]) != settings.instance_id
            or not isinstance(value["sources"], list)
            or not 1 <= len(value["sources"]) <= 8
        ):
            raise RegistryError()
        result={}
        for item in value["sources"]:
            required = {
                "alias",
                "instance",
                "kind",
                "owners",
                "timezone",
                "schemaHash",
                "locator",
                "expectedDatabase",
                "expectedDataDirectory",
                "expectedRole",
                "expectedFileIdentity",
                "expectedDatasetIdentity",
            }
            allowed = required | ({"migrationWindow"} if value["version"] == 2 else set())
            if set(item) - allowed or not required <= set(item):
                raise RegistryError()
            if not re.fullmatch('[a-z0-9][a-z0-9_-]{2,63}',item['alias']) or item['alias'] in result or item['kind'] != 'postgres' or not re.fullmatch('[a-f0-9]{64}',item['schemaHash']):raise RegistryError()
            if not isinstance(item['instance'],str) or not 1<=len(item['instance'])<=200 or not isinstance(item['owners'],list) or not 1<=len(item['owners'])<=100 or any(not isinstance(owner,str) or not 1<=len(owner)<=200 or any(ord(c)<32 for c in owner) for owner in item['owners']):raise RegistryError()
            if item['timezone'] is not None:ZoneInfo(item['timezone'])
            directory=Path(item['expectedDataDirectory']) if item['expectedDataDirectory'] is not None else None
            identity=tuple(item['expectedFileIdentity']) if item['expectedFileIdentity'] is not None else None
            if item['kind']=='postgres' and (not directory or not directory.is_absolute() or not item['expectedDatabase'] or not item['expectedRole']):raise RegistryError()
            dataset=item['expectedDatasetIdentity']
            if dataset is not None and (not isinstance(dataset,dict) or set(dataset)!={'kind','systemIdentifier','databaseOid'} or dataset['kind']!='postgres' or any(not isinstance(dataset[k],str) or not dataset[k].isdigit() for k in ('systemIdentifier','databaseOid'))):raise RegistryError()
            definition = SourceDefinition(
                item["alias"],
                item["instance"],
                item["kind"],
                tuple(item["owners"]),
                item["timezone"],
                item["schemaHash"],
                item["locator"],
                item["expectedDatabase"],
                directory,
                item["expectedRole"],
                identity,
                dataset,
                migration_window=parse_window(item.get("migrationWindow")),
                window_registry_path=path,
                window_platform_instance=settings.instance_id,
            )
            result[definition.alias]=definition
        return result
    except (ValueError, TypeError, KeyError, OSError):
        # Never put locator, password, host, path or raw JSON in an error or log.
        raise RegistryError('来源登记文件权限、实例身份或结构不匹配') from None
