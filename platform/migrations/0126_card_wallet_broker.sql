ALTER TABLE card_wallet_accounts ADD COLUMN account_kind text CHECK(account_kind IN ('real','simulated'));
CREATE TABLE card_wallet_cash_links(
 owner_id text NOT NULL,request_id uuid NOT NULL,card_entry_id uuid NOT NULL,cash_entry_id uuid NOT NULL,
 account_id text NOT NULL,account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),currency text NOT NULL,
 card_delta numeric(40,18) NOT NULL,cash_delta numeric(40,18) NOT NULL,reversal_of uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,card_entry_id) REFERENCES card_wallet_entries(owner_id,id),
 FOREIGN KEY(cash_entry_id) REFERENCES cash_ledger_entries(id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,reversal_of) REFERENCES card_wallet_cash_links(owner_id,request_id),
 UNIQUE(cash_entry_id),UNIQUE(owner_id,reversal_of),CHECK(card_delta+cash_delta=0)
);
CREATE UNIQUE INDEX card_wallet_cash_original ON card_wallet_cash_links(owner_id,card_entry_id) WHERE reversal_of IS NULL;
CREATE TRIGGER immutable_card_wallet_cash_link BEFORE UPDATE OR DELETE ON card_wallet_cash_links FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_card_wallet_cash_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c cash_ledger_entries; BEGIN
 SELECT * INTO c FROM cash_ledger_entries WHERE id=NEW.cash_entry_id;
 IF c.owner_id IS DISTINCT FROM NEW.owner_id OR c.account_id IS DISTINCT FROM NEW.account_id OR c.account_kind IS DISTINCT FROM NEW.account_kind OR c.currency IS DISTINCT FROM NEW.currency OR c.amount IS DISTINCT FROM NEW.cash_delta OR c.affects_owner IS NOT TRUE OR c.kind NOT IN ('external_deposit','external_withdrawal') THEN RAISE EXCEPTION 'card cash link scope mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM card_wallet_entries e WHERE e.owner_id=NEW.owner_id AND e.id=NEW.card_entry_id AND e.currency=NEW.currency AND ((e.kind='deposit' AND NEW.card_delta=e.original_amount AND c.kind='external_withdrawal') OR (e.kind='withdraw' AND NEW.card_delta=-e.original_amount AND c.kind='external_deposit'))) THEN RAISE EXCEPTION 'card cash original event mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM card_wallet_cash_links p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.reversal_of AND p.reversal_of IS NULL AND p.card_entry_id=NEW.card_entry_id AND p.account_id=NEW.account_id AND p.account_kind=NEW.account_kind AND p.currency=NEW.currency AND p.card_delta=-NEW.card_delta AND c.reversal_entry_id=p.cash_entry_id) THEN RAISE EXCEPTION 'card cash reversal mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER guard_card_wallet_cash_link BEFORE INSERT ON card_wallet_cash_links FOR EACH ROW EXECUTE FUNCTION check_card_wallet_cash_link();
-- Card financial parents and their distinct derived cash child UUIDs cannot
-- reuse another domain's request. Preserve every pre-existing domain variant.
DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='asset_request_domains'::regclass AND conname='asset_request_domains_domain_check';
 IF previous IS NULL THEN RAISE EXCEPTION 'asset request domain constraint missing'; END IF;
 ALTER TABLE asset_request_domains DROP CONSTRAINT asset_request_domains_domain_check;
 EXECUTE 'ALTER TABLE asset_request_domains ADD CONSTRAINT asset_request_domains_domain_check CHECK (('||previous||') OR domain=''card_wallet'')';
 IF EXISTS(SELECT 1 FROM card_wallet_operations c JOIN asset_request_domains d ON d.owner_id=c.owner_id AND d.request_id=c.request_id WHERE c.kind IN ('financial','closed') AND d.domain<>'card_wallet') OR EXISTS(SELECT 1 FROM card_wallet_operations c JOIN broker_request_domains d ON d.owner_id=c.owner_id AND d.request_id=c.request_id WHERE c.kind IN ('financial','closed') AND d.domain<>'asset') THEN RAISE EXCEPTION 'historical card request UUID collision'; END IF;
END $$;
INSERT INTO broker_request_domains(owner_id,request_id,domain) SELECT owner_id,request_id,'asset' FROM card_wallet_operations WHERE kind IN ('financial','closed') ON CONFLICT DO NOTHING;
INSERT INTO asset_request_domains(owner_id,request_id,domain) SELECT owner_id,request_id,'card_wallet' FROM card_wallet_operations WHERE kind IN ('financial','closed') ON CONFLICT DO NOTHING;
CREATE TRIGGER card_wallet_request_domain BEFORE INSERT ON card_wallet_operations
 FOR EACH ROW WHEN (NEW.kind IN ('financial','closed')) EXECUTE FUNCTION reserve_asset_request_domain('card_wallet');
