-- Verified parent-fill identity is the only authority for OCO max reservations.
CREATE TABLE internal_order_families (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, parent_order_id uuid NOT NULL,
 account_id text NOT NULL, account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 record_id text NOT NULL, currency text NOT NULL, quantity numeric NOT NULL CHECK(quantity>0),
 parent_fill_request uuid NOT NULL, fill_evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,parent_order_id), FOREIGN KEY(owner_id,parent_order_id) REFERENCES internal_orders(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
CREATE TABLE internal_order_family_legs (
 owner_id text NOT NULL, family_id uuid NOT NULL, order_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('take_profit','stop_loss')), trigger_price numeric NOT NULL CHECK(trigger_price>0),
 trigger_above boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,order_id), UNIQUE(owner_id,family_id,role),
 FOREIGN KEY(owner_id,family_id) REFERENCES internal_order_families(owner_id,id),
 FOREIGN KEY(owner_id,order_id) REFERENCES internal_orders(owner_id,id)
);
CREATE FUNCTION guard_internal_order_family_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM internal_order_families f JOIN internal_orders p ON p.owner_id=f.owner_id AND p.id=f.parent_order_id
   JOIN internal_orders c ON c.owner_id=f.owner_id AND c.id=NEW.order_id
   WHERE f.owner_id=NEW.owner_id AND f.id=NEW.family_id AND p.status='filled'
   AND c.account_id=f.account_id AND c.account_kind=f.account_kind AND c.record_id=f.record_id
   AND c.currency=f.currency AND c.quantity=f.quantity AND c.side<>p.side AND c.id<>p.id)
 THEN RAISE EXCEPTION 'OCO leg requires exact parent-fill scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER internal_order_family_leg_scope BEFORE INSERT ON internal_order_family_legs FOR EACH ROW EXECUTE FUNCTION guard_internal_order_family_leg();
CREATE TRIGGER immutable_internal_order_families BEFORE UPDATE OR DELETE ON internal_order_families FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_internal_order_family_legs BEFORE UPDATE OR DELETE ON internal_order_family_legs FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
