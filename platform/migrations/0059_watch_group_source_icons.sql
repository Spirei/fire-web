-- Original file captures use the existing ResourceMedia byte authority and 54 receipts.
CREATE TABLE watch_group_source_icon_captures(
 owner_id text NOT NULL,request_id uuid NOT NULL,manifest_id uuid NOT NULL,original_group_id text NOT NULL,
 source_row_sha256 text NOT NULL,source_reference text NOT NULL,root_binding_hash text,
 state text NOT NULL CHECK(state IN ('captured','blocked','empty','market_default')),
 reason text,file_name text,original_sha256 text,original_size bigint,file_identity jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES watch_group_import_operations(owner_id,request_id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES watch_group_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,original_sha256) REFERENCES resource_media_objects(owner_id,sha256),
 CHECK((state='captured' AND original_sha256 IS NOT NULL AND original_size IS NOT NULL AND original_size BETWEEN 1 AND 2097152 AND file_name IS NOT NULL AND root_binding_hash IS NOT NULL AND root_binding_hash ~ '^[a-f0-9]{64}$' AND file_identity IS NOT NULL) OR
       (state<>'captured' AND original_sha256 IS NULL AND original_size IS NULL))
);
CREATE FUNCTION guard_watch_group_source_icon_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m watch_group_source_manifests;original jsonb;rawrow jsonb;
BEGIN
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
CREATE TRIGGER guard_watch_group_source_icon_capture BEFORE INSERT OR UPDATE OR DELETE ON watch_group_source_icon_captures FOR EACH ROW EXECUTE FUNCTION guard_watch_group_source_icon_capture();
CREATE TABLE watch_group_source_icon_links(
 owner_id text NOT NULL,request_id uuid NOT NULL,capture_request_id uuid NOT NULL,
 target_group_id text NOT NULL,version_id uuid NOT NULL REFERENCES watch_group_icon_versions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES watch_group_import_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,request_id) REFERENCES watch_group_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,capture_request_id) REFERENCES watch_group_source_icon_captures(owner_id,request_id),
 FOREIGN KEY(owner_id,target_group_id) REFERENCES watch_groups(owner_id,id)
);
CREATE FUNCTION guard_watch_group_source_icon_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source icon application is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM watch_group_source_icon_captures c JOIN watch_group_source_manifests m ON m.owner_id=c.owner_id AND m.id=c.manifest_id
  JOIN watch_group_source_bindings b ON b.owner_id=c.owner_id AND b.source_instance=m.source_instance AND b.source_owner=m.source_owner AND b.original_group_id=c.original_group_id
  JOIN watch_group_icon_versions v ON v.owner_id=b.owner_id AND v.group_id=b.target_group_id AND v.id=NEW.version_id
  WHERE c.owner_id=NEW.owner_id AND c.request_id=NEW.capture_request_id AND c.state='captured' AND b.target_group_id=NEW.target_group_id AND b.kind='custom'
  AND v.original_sha256=c.original_sha256 AND v.original_size=c.original_size)
 THEN RAISE EXCEPTION 'source icon application requires exact owner/group/original-byte binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_watch_group_source_icon_link BEFORE INSERT OR UPDATE OR DELETE ON watch_group_source_icon_links FOR EACH ROW EXECUTE FUNCTION guard_watch_group_source_icon_link();
