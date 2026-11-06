"""Current platform consent for captured bytes, independent of expired source I/O rights."""

from fastapi import HTTPException

from .source_snapshot import canonical, sha


async def archive_grant(authority, conn, who, grant_id, revision, *, manifest_id, archive_kind):
    # No source registry/definition/path/window access is allowed in this helper.
    # The caller still owns its domain locks, immutable head/coverage/preview/CAS.
    row = await (await conn.execute("SELECT g.* FROM legacy_source_grants g JOIN alcor_instance i ON i.instance_id=g.platform_instance WHERE g.id=%s AND g.owner_id=%s AND g.state='active' FOR SHARE OF g", (grant_id, who.id))).fetchone()
    if not row or row['revision'] != revision or row['platform_instance'] != authority.db.settings.instance_id:
        raise HTTPException(409, '平台归档来源授权未生效、已撤销或版本已变化')
    claims = await authority.check_claim(conn, row['source_instance'], row['source_owner'], who.id, row['physical_identity_hash'])
    if len(claims) != 1 or claims[0]['platform_instance'] != row['platform_instance']:
        raise HTTPException(409, '缺少同一实例及本人永久来源归属，不能应用归档')
    if archive_kind == 'financial':
        stored = await (await conn.execute("SELECT m.*,EXISTS(SELECT 1 FROM legacy_source_operations o WHERE o.owner_id=m.owner_id AND o.state='completed' AND o.result->>'state'='completed' AND o.result->>'manifestId'=m.id::text AND o.result->>'manifestSha256'=m.manifest_sha256 AND o.result->>'sourceBindingHash'=%s) captured FROM legacy_source_manifests m WHERE m.owner_id=%s AND m.id=%s", (row['binding_hash'], who.id, manifest_id))).fetchone()
        if not stored:
            raise HTTPException(409, '本人已捕获的不可变归档清单不存在')
        manifest = stored['manifest']; source = manifest.get('source', {})
        valid = (
            stored['captured'] and stored['grant_id'] == row['id'] and stored['grant_revision'] == revision
            and source.get('instance') == row['source_instance'] and source.get('owner') == row['source_owner']
            and manifest.get('sourceBindingHash') == row['binding_hash']
            and manifest.get('grantId') == str(row['id']) and manifest.get('grantRevision') == revision
            and sha(canonical(manifest)) == stored['manifest_sha256']
            and sha(bytes(stored['raw'])) == manifest.get('rawSha256')
        )
    elif archive_kind == 'watch_groups':
        installed = await (await conn.execute("SELECT to_regclass('watch_group_source_manifests') name")).fetchone()
        if not installed['name']:
            raise HTTPException(409, '分组来源归档尚未安装')
        stored = await (await conn.execute("SELECT m.*,EXISTS(SELECT 1 FROM watch_group_import_operations o WHERE o.owner_id=m.owner_id AND o.request_id=m.request_id AND o.kind='capture' AND o.state='completed' AND o.result->>'state'='completed' AND o.result->>'manifestId'=m.id::text AND o.result->>'rawSha256'=m.raw_sha256) captured FROM watch_group_source_manifests m WHERE m.owner_id=%s AND m.id=%s", (who.id, manifest_id))).fetchone()
        if not stored:
            raise HTTPException(409, '本人已捕获的不可变分组归档清单不存在')
        manifest = stored['manifest']; source = manifest.get('source', {})
        valid = (
            stored['captured'] and stored['grant_id'] == row['id'] and stored['grant_revision'] == revision
            and stored['source_instance'] == row['source_instance'] and stored['source_owner'] == row['source_owner']
            and stored['physical_identity_hash'] == row['physical_identity_hash'] and stored['binding_hash'] == row['binding_hash']
            and source.get('instance') == row['source_instance'] and source.get('owner') == row['source_owner']
            and manifest.get('metadataBindingHash') == stored['metadata_binding_hash']
            and source.get('schemaHash') == stored['schema_hash']
            and sha(bytes(stored['raw'])) == stored['raw_sha256'] == manifest.get('rawSha256')
        )
    else:
        raise HTTPException(422, '归档领域无效')
    if not valid:
        raise HTTPException(409, '归档捕获回执、来源身份或不可变摘要不匹配')
    return row
