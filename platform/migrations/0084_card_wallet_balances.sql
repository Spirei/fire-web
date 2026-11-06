-- Owner-declared manual card amounts are not broker cash, imported ledgers or observed market history.
CREATE TABLE card_wallet_collections (
 owner_id text PRIMARY KEY REFERENCES users(id), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE card_wallet_details (
 owner_id text NOT NULL REFERENCES users(id), card_key text NOT NULL,
 metadata jsonb NOT NULL, secret_ciphertext text, crypto_instance uuid NOT NULL,
 initialized_fields text[] NOT NULL DEFAULT '{}', revision bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,card_key)
);
CREATE TABLE card_wallet_accounts (
 owner_id text NOT NULL REFERENCES users(id), card_key text NOT NULL,
 source_kind text NOT NULL DEFAULT 'platform-manual-card' CHECK(source_kind='platform-manual-card'),
 amount numeric(40,18), currency text CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 opening_amount numeric(40,18), opening_at timestamptz, basis_id uuid,
 note text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,card_key), CHECK(amount IS NULL OR abs(amount)<=1000000000000),
 CHECK(opening_amount IS NULL OR abs(opening_amount)<=1000000000000)
);
CREATE TABLE card_wallet_checkpoints (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, card_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('set_amount','clear_amount')), amount numeric(40,18),
 currency text, note text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,card_key) REFERENCES card_wallet_accounts(owner_id,card_key)
);
CREATE TRIGGER card_wallet_checkpoint_immutable BEFORE UPDATE OR DELETE ON card_wallet_checkpoints
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE card_wallet_entries (
 owner_id text NOT NULL, id uuid NOT NULL, card_key text NOT NULL, basis_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deposit','withdraw','adjust')),
 original_amount numeric(40,18) NOT NULL, target_amount numeric(40,18),
 delta numeric(40,18), balance numeric(40,18), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 note text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL,
 order_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
 projection_revision bigint NOT NULL,
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,card_key) REFERENCES card_wallet_accounts(owner_id,card_key),
 CHECK(abs(original_amount)<=1000000000000), CHECK(target_amount IS NULL OR abs(target_amount)<=1000000000000)
);
CREATE INDEX card_wallet_history ON card_wallet_entries(owner_id,card_key,occurred_at DESC,order_id DESC);
CREATE FUNCTION guard_card_wallet_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.owner_id,NEW.id,NEW.card_key,NEW.basis_id,NEW.kind,NEW.original_amount,NEW.target_amount,NEW.currency,NEW.note,NEW.occurred_at,NEW.order_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.owner_id,OLD.id,OLD.card_key,OLD.basis_id,OLD.kind,OLD.original_amount,OLD.target_amount,OLD.currency,OLD.note,OLD.occurred_at,OLD.order_id,OLD.created_at)
 OR OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
 THEN RAISE EXCEPTION 'immutable card wallet event'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER card_wallet_event_immutable BEFORE UPDATE ON card_wallet_entries FOR EACH ROW EXECUTE FUNCTION guard_card_wallet_event();
CREATE TRIGGER card_wallet_event_no_delete BEFORE DELETE ON card_wallet_entries FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE card_wallet_previews (
 token_hash text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), session_hash text NOT NULL,
 payload_hash text NOT NULL, revision bigint NOT NULL, preference_revision bigint NOT NULL,
 plan_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE card_wallet_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('financial','details','closed')),
 fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
