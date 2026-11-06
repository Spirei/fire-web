-- Immutable live originals/receipts may be retired only inside a real closed-account transaction.
CREATE OR REPLACE FUNCTION guard_watch_group_icon_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable live personal group icon version';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable personal group icon version'; END IF;
 IF NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.original_sha256 AND byte_length=NEW.original_size)
 OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.served_sha256 AND byte_length=NEW.served_size)
 OR NOT EXISTS(SELECT 1 FROM watch_groups WHERE owner_id=NEW.owner_id AND id=NEW.group_id AND kind='custom' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'personal group icon bytes or owner mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_personal_font() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE public_uid text; existing bigint;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable live personal font';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable personal font'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('personal-fonts:'||NEW.owner_id,0));
 SELECT uid INTO public_uid FROM users WHERE id=NEW.owner_id AND active;
 IF public_uid IS NULL OR NEW.id <> 'custom-'||public_uid||'-'||NEW.sha256||'.'||NEW.extension
 OR NEW.media_type <> 'font/'||NEW.extension
 OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.sha256 AND byte_length=NEW.byte_length)
 THEN RAISE EXCEPTION 'font identity or bytes mismatch'; END IF;
 SELECT count(*) INTO existing FROM personal_fonts WHERE owner_id=NEW.owner_id;
 IF existing>=20 THEN RAISE EXCEPTION 'personal font quota exceeded'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_personal_font_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL)
 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'immutable personal font receipt';
END $$;

CREATE OR REPLACE FUNCTION guard_watch_group_source_icon_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m watch_group_source_manifests;original jsonb;rawrow jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable live source icon evidence';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source icon capture is immutable'; END IF;
 SELECT * INTO m FROM watch_group_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 original=m.manifest#>ARRAY['groupIndex',NEW.original_group_id];
 SELECT r INTO rawrow FROM jsonb_array_elements(convert_from(m.raw,'UTF8')::jsonb#>'{tables,watch_groups}') r WHERE r#>>'{id,text}'=NEW.original_group_id;
 IF original IS NULL OR rawrow IS NULL OR original->>'rowSha256' IS DISTINCT FROM NEW.source_row_sha256 OR coalesce(rawrow#>>'{icon,text}','') IS DISTINCT FROM NEW.source_reference
 OR NOT EXISTS(SELECT 1 FROM watch_group_import_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.kind='capture' AND o.state='reading' AND o.result->>'domain'='source_icon')
 THEN RAISE EXCEPTION 'source icon requires exact original group and accepted capture receipt'; END IF;
 IF NEW.state='captured' AND (original->>'kind'<>'custom' OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.original_sha256 AND byte_length=NEW.original_size))
 THEN RAISE EXCEPTION 'source icon bytes require same owner and custom source group'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_watch_group_source_icon_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable live source icon evidence';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source icon application is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM watch_group_source_icon_captures c JOIN watch_group_source_manifests m ON m.owner_id=c.owner_id AND m.id=c.manifest_id
  JOIN watch_group_source_bindings b ON b.owner_id=c.owner_id AND b.source_instance=m.source_instance AND b.source_owner=m.source_owner AND b.original_group_id=c.original_group_id
  JOIN watch_group_icon_versions v ON v.owner_id=b.owner_id AND v.group_id=b.target_group_id AND v.id=NEW.version_id
  WHERE c.owner_id=NEW.owner_id AND c.request_id=NEW.capture_request_id AND c.state='captured' AND b.target_group_id=NEW.target_group_id AND b.kind='custom'
  AND v.original_sha256=c.original_sha256 AND v.original_size=c.original_size)
 THEN RAISE EXCEPTION 'source icon application requires exact owner/group/original-byte binding'; END IF;
 RETURN NEW;
END $$;
