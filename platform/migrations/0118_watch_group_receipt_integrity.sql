-- Group, ordering and icon operations are immutable original UUID receipts.
CREATE TRIGGER immutable_watch_group_operations BEFORE UPDATE OR DELETE ON watch_group_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
