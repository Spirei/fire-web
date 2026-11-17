-- Phase detail now lists the slowest phases first and keeps enough of them
-- to identify the source of a multi-second snapshot.
ALTER TABLE request_observations DROP CONSTRAINT request_observations_timing_check;
ALTER TABLE request_observations ADD CONSTRAINT request_observations_timing_check
 CHECK (timing IS NULL OR length(timing)<=1024);
