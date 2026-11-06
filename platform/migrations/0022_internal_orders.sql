-- Internal limit orders reserve verified resources. They are not broker orders or actual fills.
CREATE TABLE internal_order_collections (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE internal_orders (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    account_id text NOT NULL,
    account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
    record_id text NOT NULL,
    record_code text NOT NULL,
    record_market text NOT NULL,
    record_account_market text NOT NULL,
    record_source text NOT NULL,
    currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
    side text NOT NULL CHECK(side IN ('buy','sell')),
    order_type text NOT NULL DEFAULT 'limit' CHECK(order_type='limit'),
    execution_enabled boolean NOT NULL DEFAULT false CHECK(NOT execution_enabled),
    quantity numeric NOT NULL CHECK(quantity>0 AND quantity<=9007199254740991 AND scale(quantity)<=18),
    limit_price numeric NOT NULL CHECK(limit_price>0 AND limit_price<=9007199254740991 AND scale(limit_price)<=18),
    fees numeric NOT NULL CHECK(fees>=0 AND fees<=9007199254740991 AND scale(fees)<=18),
    reservation_cash numeric NOT NULL CHECK(reservation_cash>=0 AND reservation_cash<=9007199254740991 AND scale(reservation_cash)<=18),
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled')),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    cancelled_at timestamptz,
    CHECK(reservation_cash=CASE WHEN side='buy' THEN quantity*limit_price+fees ELSE 0 END),
    CHECK((status='pending' AND cancelled_at IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL)),
    UNIQUE(owner_id,id),
    FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
    FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
CREATE INDEX internal_order_pending ON internal_orders(owner_id,account_kind,currency,created_at,id) WHERE status='pending';
CREATE INDEX internal_order_record ON internal_orders(owner_id,record_id,status);
CREATE TABLE internal_order_previews (
    token_hash text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    session_hash text NOT NULL,
    fingerprint text NOT NULL,
    dependencies jsonb NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
    consumed_at timestamptz
);
CREATE TABLE internal_order_operations (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_internal_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'internal order history is retained' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' THEN
        IF OLD.status<>'pending' OR NEW.status<>'cancelled' OR
           (to_jsonb(NEW)-'status'-'revision'-'cancelled_at') IS DISTINCT FROM
           (to_jsonb(OLD)-'status'-'revision'-'cancelled_at') THEN
            RAISE EXCEPTION 'internal order change requires an explicit revisioned operation' USING ERRCODE='23514';
        END IF;
        NEW.revision:=OLD.revision+1;
    END IF;
    INSERT INTO internal_order_collections(owner_id,revision) VALUES(NEW.owner_id,1)
    ON CONFLICT(owner_id) DO UPDATE SET revision=internal_order_collections.revision+1;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_internal_order_change BEFORE INSERT OR UPDATE OR DELETE ON internal_orders
FOR EACH ROW EXECUTE FUNCTION guard_internal_order_change();
CREATE FUNCTION internal_order_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency)
    VALUES(NEW.owner_id,NEW.account_id,'order',NEW.id::text,NEW.currency);
    RETURN NEW;
END $$;
CREATE TRIGGER internal_order_reference AFTER INSERT ON internal_orders
FOR EACH ROW EXECUTE FUNCTION internal_order_reference();
