CREATE TABLE native_ledger_transferred_orders (
  owner_id text NOT NULL REFERENCES native_ledger_heads(owner_id),
  order_id uuid NOT NULL,
  legacy_revision bigint NOT NULL CHECK (legacy_revision>0),
  PRIMARY KEY (owner_id,order_id),
  FOREIGN KEY (owner_id,order_id) REFERENCES internal_orders(owner_id,id)
);
CREATE TRIGGER native_ledger_transferred_order_retained
BEFORE UPDATE OR DELETE ON native_ledger_transferred_orders
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE FUNCTION reject_transferred_internal_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM native_ledger_transferred_orders
             WHERE owner_id=OLD.owner_id AND order_id=OLD.id) THEN
    RAISE EXCEPTION 'Internal order has transferred to the App ledger'
      USING ERRCODE='23514',CONSTRAINT='native_ledger_transferred_order_read_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_ledger_transferred_order_read_only
BEFORE UPDATE ON internal_orders
FOR EACH ROW EXECUTE FUNCTION reject_transferred_internal_order_update();
