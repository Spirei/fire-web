-- A terminal protocol page proves the recorded window/page chain, never complete business history.
CREATE TABLE market_coverage_receipts(
 owner_id text NOT NULL,stream_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),
 page_ids uuid[] NOT NULL CHECK(cardinality(page_ids) BETWEEN 1 AND 100),terminal_page uuid NOT NULL,
 window_from date NOT NULL,window_through date NOT NULL CHECK(window_through>=window_from),
 assurance text NOT NULL CHECK(assurance ~ '^(controlled|source)_terminal_pages(_empty)?(_partial_records)?$'),
 point_count integer NOT NULL CHECK(point_count>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,task_id),FOREIGN KEY(owner_id,stream_id) REFERENCES market_streams(owner_id,id),
 FOREIGN KEY(owner_id,terminal_page) REFERENCES market_source_pages(owner_id,id),
 CHECK((point_count=0)=(position('_empty' in assurance)>0))
);
CREATE FUNCTION validate_market_coverage_pages() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR stream.query->>'kind'<>'bars' OR NEW.window_from<>((stream.query->>'start')::date)
 OR NEW.window_through<>((stream.query->>'through')::date) THEN
  RAISE EXCEPTION 'market coverage source page chain mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_coverage_source_proof BEFORE INSERT ON market_coverage_receipts FOR EACH ROW EXECUTE FUNCTION validate_market_coverage_pages();
CREATE TRIGGER immutable_market_coverage BEFORE UPDATE OR DELETE ON market_coverage_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE INDEX market_coverage_stream ON market_coverage_receipts(owner_id,stream_id,created_at DESC);
