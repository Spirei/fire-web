-- Extend the existing feed admission authority; do not fabricate historical inputs.
ALTER TABLE feed_source_admissions
 ADD COLUMN stage text NOT NULL DEFAULT 'legacy'
 CHECK(stage IN ('legacy','plan','rss','search','article','edit','review','discussion','translate')),
 ADD COLUMN input_bytes bytea,
 ADD COLUMN input_sha256 text,
 ADD COLUMN predecessor_page_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
ALTER TABLE feed_source_admissions ADD CONSTRAINT feed_stage_input_evidence CHECK(
 (stage='legacy' AND input_bytes IS NULL AND input_sha256 IS NULL AND cardinality(predecessor_page_ids)=0)
 OR (stage<>'legacy' AND input_bytes IS NOT NULL AND octet_length(input_bytes) BETWEEN 2 AND 131072
     AND input_sha256 IS NOT NULL AND input_sha256=encode(sha256(input_bytes),'hex')
     AND cardinality(predecessor_page_ids) BETWEEN 0 AND 64));
COMMENT ON COLUMN feed_source_admissions.input_bytes IS 'Immutable owner-scoped exact semantic request input, excluding authentication headers/credentials; old legacy rows remain explicitly unknown.';
CREATE FUNCTION guard_feed_stage_request_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job feed_source_jobs;body jsonb;page_id uuid;
BEGIN
 IF NEW.stage='legacy' THEN RETURN NEW; END IF;
 SELECT * INTO job FROM feed_source_jobs WHERE owner_id=NEW.owner_id AND id=NEW.job_id;
 BEGIN body:=convert_from(NEW.input_bytes,'UTF8')::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'feed stage input must be retained UTF8 JSON' USING ERRCODE='23514'; END;
 IF job.id IS NULL OR jsonb_typeof(body)<>'object'
 OR NOT(body ?& ARRAY['ownerId','jobId','requestId','instanceId','groupRevision','stage','predecessorPageIds','input'])
 OR body->>'ownerId' IS DISTINCT FROM NEW.owner_id OR body->>'jobId' IS DISTINCT FROM NEW.job_id::text
 OR body->>'requestId' IS DISTINCT FROM job.request_id::text
 OR body->>'instanceId' IS DISTINCT FROM job.subject->>'instanceId'
 OR body->>'groupRevision' IS DISTINCT FROM job.group_revision::text
 OR body->>'stage' IS DISTINCT FROM NEW.stage
 OR body->'predecessorPageIds' IS DISTINCT FROM to_jsonb(NEW.predecessor_page_ids)
 OR jsonb_typeof(body->'input') NOT IN ('object','array')
 OR cardinality(NEW.predecessor_page_ids)<>(SELECT count(DISTINCT value) FROM unnest(NEW.predecessor_page_ids) value)
 THEN RAISE EXCEPTION 'feed stage input must bind the original owner job instance revision and exact predecessors' USING ERRCODE='23514'; END IF;
 FOREACH page_id IN ARRAY NEW.predecessor_page_ids LOOP
  IF NOT EXISTS(SELECT 1 FROM feed_source_pages p WHERE p.owner_id=NEW.owner_id AND p.job_id=NEW.job_id
    AND p.id=page_id AND p.raw_sha256=encode(sha256(p.raw),'hex'))
  THEN RAISE EXCEPTION 'feed stage predecessor must be an immutable same-owner same-job original with verified SHA' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_feed_stage_request_evidence BEFORE INSERT ON feed_source_admissions
 FOR EACH ROW EXECUTE FUNCTION guard_feed_stage_request_evidence();
