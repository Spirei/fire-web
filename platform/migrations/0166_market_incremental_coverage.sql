-- An incremental minute-history task observes only the missing tail of its
-- canonical stream window. The receipt stays truthful: it records the actual
-- window start and is marked incremental, while the original full-window
-- receipt remains the history coverage proof.
ALTER TABLE market_coverage_receipts ADD COLUMN incremental boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION validate_market_coverage_pages() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terminal market_source_pages; stream market_streams; total integer;
BEGIN
 SELECT * INTO STRICT stream FROM market_streams WHERE owner_id=NEW.owner_id AND id=NEW.stream_id;
 SELECT * INTO STRICT terminal FROM market_source_pages WHERE owner_id=NEW.owner_id AND id=NEW.terminal_page;
 SELECT count(*) INTO total FROM market_source_pages WHERE owner_id=NEW.owner_id AND task_id=NEW.task_id;
 IF terminal.task_id<>NEW.task_id OR terminal.cursor_out IS NOT NULL
 OR NOT NEW.terminal_page=ANY(NEW.page_ids) OR total<>cardinality(NEW.page_ids)
 OR (SELECT count(DISTINCT id) FROM unnest(NEW.page_ids) AS p(id))<>total
 OR EXISTS(SELECT 1 FROM unnest(NEW.page_ids) AS p(id) LEFT JOIN market_source_pages s ON s.owner_id=NEW.owner_id AND s.id=p.id
           WHERE s.id IS NULL OR s.task_id<>NEW.task_id OR s.source_revision<>stream.source_revision)
 OR terminal.page_number<>(SELECT max(page_number) FROM market_source_pages WHERE owner_id=NEW.owner_id AND task_id=NEW.task_id)
 OR stream.query->>'kind' NOT IN ('bars','price_series')
 OR (stream.query->>'kind'='bars' AND position('_terminal_pages' in NEW.assurance)=0)
 OR (stream.query->>'kind'='price_series' AND position('_rt_observed_snapshot' in NEW.assurance)=0)
 OR NEW.window_through<>((stream.query->>'through')::date)
 OR (NOT NEW.incremental AND NEW.window_from<>((stream.query->>'start')::date))
 OR (NEW.incremental AND (NEW.window_from<((stream.query->>'start')::date)
     OR NEW.window_from>((stream.query->>'through')::date))) THEN
  RAISE EXCEPTION 'market coverage source page chain mismatch';
 END IF;
 RETURN NEW;
END $$;
