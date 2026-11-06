-- Stable account identity. No name-based ownership inference or automatic source migration.
CREATE TABLE broker_account_collections (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE broker_accounts (
    id text PRIMARY KEY CHECK (id ~ '^ba-[a-f0-9]{24}$'),
    owner_id text NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    provider_id text,
    account_kind text NOT NULL CHECK (account_kind IN ('real','simulated','unknown')),
    holding_source text NOT NULL DEFAULT 'manual' CHECK (holding_source IN ('manual','official')),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currencies text[] NOT NULL CHECK (cardinality(currencies) BETWEEN 1 AND 14 AND currency=ANY(currencies)),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX broker_account_active_name ON broker_accounts(owner_id,lower(name)) WHERE deleted_at IS NULL;
-- Domain writers register references in their own transaction; references retain historical account identity.
-- A NULL currency means the source has not proved its currency, not that no currency is in use.
CREATE TABLE broker_account_references (
    owner_id text NOT NULL,
    account_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('position','cash','statement','order','connection')),
    reference_id text NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 200),
    currency text CHECK(currency ~ '^[A-Z]{3}$'),
    PRIMARY KEY(owner_id,account_id,kind,reference_id),
    FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TABLE broker_account_operations (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_broker_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.account_kind IS DISTINCT FROM OLD.account_kind THEN
       RAISE EXCEPTION 'broker identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
       RAISE EXCEPTION 'broker tombstone is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND EXISTS(
       SELECT 1 FROM broker_account_references WHERE owner_id=OLD.owner_id AND account_id=OLD.id
    ) THEN
       RAISE EXCEPTION 'broker account is referenced' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER broker_account_identity BEFORE UPDATE ON broker_accounts
FOR EACH ROW EXECUTE FUNCTION guard_broker_account_identity();
CREATE FUNCTION guard_broker_account_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target broker_accounts;
BEGIN
    SELECT * INTO target FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=NEW.account_id FOR UPDATE;
    IF NOT FOUND OR target.deleted_at IS NOT NULL THEN
       RAISE EXCEPTION 'broker account unavailable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER broker_account_reference BEFORE INSERT OR UPDATE ON broker_account_references
FOR EACH ROW EXECUTE FUNCTION guard_broker_account_reference();
CREATE FUNCTION retain_broker_account_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'broker accounts require retained tombstones' USING ERRCODE='23514';
END $$;
CREATE TRIGGER broker_account_no_delete BEFORE DELETE ON broker_accounts
FOR EACH ROW EXECUTE FUNCTION retain_broker_account_history();
