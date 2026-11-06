-- A prepared owner-bound closure can be observed after its sessions are revoked.
-- The random read/close capability is never stored in plaintext and grants no login.
CREATE TABLE account_closure_intents (
 owner_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 prepared_session_hash text NOT NULL CHECK(prepared_session_hash ~ '^[a-f0-9]{64}$'),
 revision uuid NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','completed','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 prepared_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
 finished_at timestamptz,
 PRIMARY KEY(owner_id,request_id),
 CHECK(created_at<prepared_until AND prepared_until<expires_at),
 CHECK((state='prepared')=(finished_at IS NULL))
);
CREATE FUNCTION protect_account_closure_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'account_closure_intent_is_retained'; END IF;
 IF OLD.state<>'prepared' OR NEW.state NOT IN ('completed','closed') OR NEW.finished_at IS NULL
 OR (NEW.owner_id,NEW.request_id,NEW.token_hash,NEW.prepared_session_hash,NEW.revision,
     NEW.created_at,NEW.prepared_until,NEW.expires_at)
 IS DISTINCT FROM
    (OLD.owner_id,OLD.request_id,OLD.token_hash,OLD.prepared_session_hash,OLD.revision,
     OLD.created_at,OLD.prepared_until,OLD.expires_at)
 THEN RAISE EXCEPTION 'account_closure_intent_transition_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_closure_intent_retained BEFORE UPDATE OR DELETE ON account_closure_intents
 FOR EACH ROW EXECUTE FUNCTION protect_account_closure_intent();
