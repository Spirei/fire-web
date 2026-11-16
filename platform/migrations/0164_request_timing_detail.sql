-- Persist the same numeric Server-Timing summary already returned to clients
-- so the request page can show where an endpoint spent its time. It contains
-- phase durations and statement counts only: no SQL, identifiers or payloads.
ALTER TABLE request_observations ADD COLUMN timing text
 CHECK (timing IS NULL OR length(timing)<=512);
