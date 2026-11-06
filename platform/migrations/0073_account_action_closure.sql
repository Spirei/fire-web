-- A UUID closed before admission can never later become an account mutation.
ALTER TABLE account_actions ADD COLUMN closed boolean NOT NULL DEFAULT false;
ALTER TABLE account_actions ADD CONSTRAINT account_action_closure_shape CHECK (
 closed = COALESCE(result->>'closed'='true',false)
 AND (NOT closed OR (result = jsonb_build_object('request_id',request_id::text,'closed',true,'executed',false)))
);
CREATE INDEX account_actions_owner_history ON account_actions(owner_id,created_at DESC,request_id DESC);
CREATE TRIGGER account_action_immutable BEFORE UPDATE OR DELETE ON account_actions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
