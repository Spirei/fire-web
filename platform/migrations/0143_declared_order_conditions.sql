-- Preserve exact original owner/context/hash/receipt guards; historical type is not trigger evidence.
CREATE OR REPLACE FUNCTION guard_trade_registration_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 IF original.id IS NULL OR original.request_id<>NEW.request_id OR original.source<>'owner_recorded'
 OR original.input_payload->'_legacyTradeContext' IS DISTINCT FROM NEW.context
 OR NEW.context->>'source' IS DISTINCT FROM 'legacy_explicit_record_request'
 OR NEW.context->>'accountId' IS DISTINCT FROM NEW.owner_id OR NEW.context->>'recordId' IS DISTINCT FROM original.record_id
 OR NEW.context->>'brokerAccountId' IS DISTINCT FROM original.account_id
 OR NEW.context->>'brokerNameAtEntry' IS DISTINCT FROM (SELECT name FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=original.account_id)
 OR NEW.context->>'brokerNameSource' IS DISTINCT FROM 'platform_account_at_entry' OR NEW.context->>'requestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.context->>'orderType' IS NULL OR NEW.context->>'tif' IS NULL OR NEW.context->>'session' IS NULL
 OR NEW.context->>'mode' IS DISTINCT FROM 'record' OR NEW.context->>'orderType' NOT IN ('market','limit','trigger_buy','trigger_sell','rebound_buy','rebound_sell')
 OR NEW.context->>'tif' NOT IN ('day','gtc','custom') OR NEW.context->>'session' NOT IN ('REGULAR','EXTENDED')
 OR ((NEW.context->>'orderType' NOT IN ('market','limit') OR NEW.context->>'tif'='custom')
     AND NEW.context->'conditionExecutionVerified' IS DISTINCT FROM 'false'::jsonb)
 THEN RAISE EXCEPTION 'legacy entry context must be exactly declared in the same original native registration' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
