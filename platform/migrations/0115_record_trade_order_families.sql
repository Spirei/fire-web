-- A recorded actual fill can be the parent without inventing an internal order.
ALTER TABLE internal_order_families ALTER COLUMN parent_order_id DROP NOT NULL;
ALTER TABLE internal_order_families ADD COLUMN parent_trade_id uuid;
ALTER TABLE internal_order_families ADD CONSTRAINT internal_family_actual_parent FOREIGN KEY(owner_id,parent_trade_id) REFERENCES trade_ledger(owner_id,id);
ALTER TABLE internal_order_families ADD CONSTRAINT internal_family_one_parent CHECK((parent_order_id IS NULL)<>(parent_trade_id IS NULL));
CREATE UNIQUE INDEX internal_family_actual_parent_unique ON internal_order_families(owner_id,parent_trade_id) WHERE parent_trade_id IS NOT NULL;
CREATE OR REPLACE FUNCTION guard_internal_order_family_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM internal_order_families f
   LEFT JOIN internal_orders p ON p.owner_id=f.owner_id AND p.id=f.parent_order_id
   LEFT JOIN trade_ledger t ON t.owner_id=f.owner_id AND t.id=f.parent_trade_id
   JOIN internal_orders c ON c.owner_id=f.owner_id AND c.id=NEW.order_id
   WHERE f.owner_id=NEW.owner_id AND f.id=NEW.family_id
   AND ((p.status='filled' AND p.account_id=f.account_id AND p.record_id=f.record_id AND p.quantity=f.quantity)
     OR (t.side IN ('buy','sell') AND t.account_id=f.account_id AND t.record_id=f.record_id AND t.account_kind=f.account_kind AND t.quantity=f.quantity))
   AND c.account_id=f.account_id AND c.account_kind=f.account_kind AND c.record_id=f.record_id
   AND c.currency=f.currency AND c.quantity=f.quantity AND c.side<>COALESCE(p.side,t.side))
 THEN RAISE EXCEPTION 'OCO leg requires exact internal or recorded parent scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
