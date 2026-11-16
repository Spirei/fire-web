-- Every quote read asks whether the owner had a failed latest task in the last
-- minute to decide whether a fresh registration is required. Failed latest
-- tasks are rare, so a partial index keeps that check out of the growing task
-- history and off a full owner scan.
CREATE INDEX tasks_failed_latest
 ON tasks(owner_id,finished_at DESC)
 WHERE kind='market.latest' AND status='failed';
