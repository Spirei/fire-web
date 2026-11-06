CREATE TABLE portfolio_record_collections (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE portfolio_records (
    owner_id text NOT NULL REFERENCES users(id),
    id text NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
    market text NOT NULL CHECK (length(market) BETWEEN 1 AND 40),
    account_market text NOT NULL DEFAULT '',
    price numeric,
    cost numeric,
    qty numeric,
    group_name text NOT NULL DEFAULT '',
    broker_account_id text,
    watch_group_id text,
    watch_group_sort integer NOT NULL DEFAULT 0,
    note text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT '',
    history_state text NOT NULL DEFAULT 'unknown' CHECK (history_state IN ('unknown','empty','has_trades')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    PRIMARY KEY(owner_id,id),
    FOREIGN KEY(owner_id,watch_group_id) REFERENCES watch_groups(owner_id,id),
    CHECK(account_market='' OR account_market=market OR (market='HK' AND account_market='CN')),
    CHECK(price IS NULL OR (price >= 0 AND price < 1e30)),
    CHECK(qty IS NULL OR (qty >= 0 AND qty < 1e30)),
    CHECK(cost IS NULL OR (cost > -1e30 AND cost < 1e30))
);
CREATE INDEX portfolio_records_owner ON portfolio_records(owner_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX portfolio_records_account ON portfolio_records(owner_id,broker_account_id) WHERE deleted_at IS NULL;
CREATE INDEX portfolio_records_group ON portfolio_records(owner_id,watch_group_id) WHERE deleted_at IS NULL;
CREATE FUNCTION portfolio_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'portfolio records require a deletion tombstone';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.owner_id <> OLD.owner_id OR NEW.id <> OLD.id THEN
            RAISE EXCEPTION 'portfolio record identity is immutable';
        END IF;
        IF OLD.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'portfolio tombstone is immutable';
        END IF;
        IF OLD.history_state='has_trades' AND NEW.history_state<>'has_trades' THEN
            RAISE EXCEPTION 'portfolio trade history cannot be cleared';
        END IF;
        NEW.revision := OLD.revision + 1;
    END IF;
    INSERT INTO portfolio_record_collections(owner_id,revision) VALUES(NEW.owner_id,1)
        ON CONFLICT(owner_id) DO UPDATE SET revision=portfolio_record_collections.revision+1;
    RETURN NEW;
END $$;
CREATE TRIGGER portfolio_record_version BEFORE INSERT OR UPDATE OR DELETE ON portfolio_records
    FOR EACH ROW EXECUTE FUNCTION portfolio_record_version();
CREATE TABLE portfolio_record_previews (
    owner_id text NOT NULL REFERENCES users(id),
    id uuid NOT NULL,
    kind text NOT NULL CHECK(kind IN ('create','update','delete')),
    record_id text NOT NULL,
    record_revision bigint,
    collection_revision bigint NOT NULL,
    normalized_input jsonb,
    dependencies jsonb NOT NULL,
    authorization_binding text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
    consumed_at timestamptz,
    PRIMARY KEY(owner_id,id)
);
CREATE TABLE portfolio_record_operations (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    preview_id uuid NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id),
    UNIQUE(owner_id,preview_id),
    FOREIGN KEY(owner_id,preview_id) REFERENCES portfolio_record_previews(owner_id,id)
);
ALTER TABLE portfolio_records ADD CONSTRAINT portfolio_record_account_fk
    FOREIGN KEY(owner_id,broker_account_id) REFERENCES broker_accounts(owner_id,id);
CREATE FUNCTION portfolio_record_account_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_deleted timestamptz;
BEGIN
    IF TG_OP='UPDATE' AND OLD.broker_account_id IS NOT NULL
        AND (NEW.broker_account_id IS DISTINCT FROM OLD.broker_account_id OR NEW.deleted_at IS NOT NULL) THEN
        DELETE FROM broker_account_references WHERE owner_id=OLD.owner_id AND account_id=OLD.broker_account_id
            AND kind='position' AND reference_id=OLD.id;
    END IF;
    IF NEW.broker_account_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
        SELECT deleted_at INTO account_deleted FROM broker_accounts
            WHERE owner_id=NEW.owner_id AND id=NEW.broker_account_id FOR UPDATE;
        IF NOT FOUND OR account_deleted IS NOT NULL THEN
            RAISE EXCEPTION 'portfolio record requires a live owned broker account';
        END IF;
        INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency)
            VALUES(NEW.owner_id,NEW.broker_account_id,'position',NEW.id,NULL) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER portfolio_record_account_reference AFTER INSERT OR UPDATE ON portfolio_records
    FOR EACH ROW EXECUTE FUNCTION portfolio_record_account_reference();
-- Display order never rewrites financial observation timestamps.
CREATE TABLE portfolio_record_orderings (
    owner_id text NOT NULL,
    view_id text NOT NULL CHECK(length(view_id) BETWEEN 1 AND 100),
    record_id text NOT NULL,
    sort integer NOT NULL CHECK(sort >= 0),
    PRIMARY KEY(owner_id,view_id,record_id),
    FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
