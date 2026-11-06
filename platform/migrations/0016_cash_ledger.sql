-- Immutable owner-currency postings and explicit broker attribution share one transaction.
CREATE TABLE cash_ledger_collections (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE cash_ledger_accounts (
    owner_id text NOT NULL,
    account_id text NOT NULL,
    currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
    opening_at timestamptz NOT NULL,
    opening_request_id uuid NOT NULL,
    opening_basis text NOT NULL CHECK(opening_basis IN ('new_external_opening','allocate_verified_unallocated_checkpoint')),
    PRIMARY KEY(owner_id,account_id,currency),
    FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TABLE cash_ledger_entries (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    account_id text,
    account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
    currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
    request_id uuid NOT NULL,
    kind text NOT NULL CHECK(kind IN ('opening','external_deposit','external_withdrawal','reconcile_balance','allocation')),
    amount numeric NOT NULL CHECK(amount <> 'NaN'::numeric AND abs(amount)<=9007199254740991 AND scale(amount)<=18),
    affects_owner boolean NOT NULL,
    CHECK (account_id IS NOT NULL OR kind='opening'),
    CHECK ((kind IN ('opening','external_deposit','allocation') AND amount>=0) OR
           (kind='external_withdrawal' AND amount<=0) OR kind='reconcile_balance'),
    CHECK ((kind='allocation' AND account_id IS NOT NULL AND NOT affects_owner) OR (kind<>'allocation' AND affects_owner)),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    note text NOT NULL CHECK(length(note)<=500),
    FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
    UNIQUE(owner_id,request_id)
);
CREATE INDEX cash_ledger_owner_currency ON cash_ledger_entries(owner_id,currency,occurred_at,id);
CREATE FUNCTION immutable_cash_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'cash postings are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_cash_entry BEFORE UPDATE OR DELETE ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TRIGGER immutable_cash_opening BEFORE UPDATE OR DELETE ON cash_ledger_accounts FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TABLE cash_ledger_previews (
    token_hash text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    session_hash text NOT NULL,
    payload_hash text NOT NULL,
    revision bigint NOT NULL,
    account_revision bigint,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE cash_ledger_operations (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);

ALTER TABLE cash_ledger_accounts ADD CONSTRAINT cash_opening_posting
FOREIGN KEY(owner_id,opening_request_id) REFERENCES cash_ledger_entries(owner_id,request_id)
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_cash_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account broker_accounts;
DECLARE opening cash_ledger_accounts;
DECLARE available numeric;
DECLARE latest timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('identity-management:'||NEW.owner_id,0));
    PERFORM pg_advisory_xact_lock(hashtextextended('broker-accounts:'||NEW.owner_id,0));
    SELECT max(occurred_at) INTO latest FROM cash_ledger_entries
    WHERE owner_id=NEW.owner_id AND currency=NEW.currency AND account_kind=NEW.account_kind;
    IF latest IS NOT NULL AND NEW.occurred_at<latest THEN
        RAISE EXCEPTION 'cash posting predates an existing checkpoint' USING ERRCODE='23514';
    END IF;
    IF NEW.kind='allocation' THEN
        SELECT coalesce(sum(amount) FILTER(WHERE affects_owner),0)
             - coalesce(sum(amount) FILTER(WHERE account_id IS NOT NULL),0) INTO available
        FROM cash_ledger_entries
        WHERE owner_id=NEW.owner_id AND currency=NEW.currency AND account_kind=NEW.account_kind;
        IF NEW.amount>available OR NOT EXISTS(SELECT 1 FROM cash_ledger_entries
            WHERE owner_id=NEW.owner_id AND currency=NEW.currency AND account_kind=NEW.account_kind
              AND account_id IS NULL AND kind='opening') THEN
            RAISE EXCEPTION 'cash allocation exceeds its proven source' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NEW.account_id IS NOT NULL THEN
        SELECT * INTO account FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=NEW.account_id FOR UPDATE;
        IF NOT FOUND OR account.deleted_at IS NOT NULL OR account.holding_source<>'manual'
           OR account.account_kind<>NEW.account_kind OR NOT NEW.currency=ANY(account.currencies) THEN
            RAISE EXCEPTION 'cash account authority mismatch' USING ERRCODE='23514';
        END IF;
        SELECT * INTO opening FROM cash_ledger_accounts
        WHERE owner_id=NEW.owner_id AND account_id=NEW.account_id AND currency=NEW.currency;
        IF NOT FOUND OR NEW.occurred_at<opening.opening_at THEN
            RAISE EXCEPTION 'cash opening is missing or later than posting' USING ERRCODE='23514';
        END IF;
        IF NEW.kind IN ('opening','allocation') AND (
           NEW.request_id<>opening.opening_request_id OR NEW.occurred_at<>opening.opening_at OR
           (NEW.kind='allocation')<>(opening.opening_basis='allocate_verified_unallocated_checkpoint')) THEN
            RAISE EXCEPTION 'cash posting does not match opening proof' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_cash_posting BEFORE INSERT ON cash_ledger_entries
FOR EACH ROW EXECUTE FUNCTION guard_cash_posting();
CREATE FUNCTION guard_cash_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id
       AND e.account_id=NEW.account_id AND e.currency=NEW.currency AND e.request_id=NEW.opening_request_id
       AND e.occurred_at=NEW.opening_at
       AND e.kind=CASE WHEN NEW.opening_basis='new_external_opening' THEN 'opening' ELSE 'allocation' END) THEN
       RAISE EXCEPTION 'cash opening requires its exact posting' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER guard_cash_opening AFTER INSERT ON cash_ledger_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_cash_opening();
