ALTER TABLE sessions DROP CONSTRAINT sessions_client_id_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_id_check
 CHECK(client_id IN ('new-web','legacy-web','legacy-v1'));
