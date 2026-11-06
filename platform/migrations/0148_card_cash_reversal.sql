-- A card-wallet inverse is a separate immutable cash fact, not a fund-source retirement.
-- Preserve the original fund-source branch and require its exact scope/amount inverse.
CREATE OR REPLACE FUNCTION guard_fund_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original cash_ledger_entries;
BEGIN
 IF NEW.reversal_entry_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO original FROM cash_ledger_entries WHERE id=NEW.reversal_entry_id FOR SHARE;
 IF original.id IS NULL OR original.owner_id<>NEW.owner_id OR original.account_kind<>NEW.account_kind OR original.currency<>NEW.currency
 OR original.account_id IS DISTINCT FROM NEW.account_id OR original.amount<>-NEW.amount OR NOT original.affects_owner OR NOT NEW.affects_owner
 OR original.source_trade_id IS NOT NULL OR original.reversal_entry_id IS NOT NULL
 OR NEW.kind NOT IN ('external_deposit','external_withdrawal')
 OR NOT (
   EXISTS(SELECT 1 FROM fund_sources f WHERE f.owner_id=NEW.owner_id AND f.cash_entry_id=original.id AND f.authority='owner_recorded')
   OR EXISTS(SELECT 1 FROM card_wallet_cash_links l
      JOIN card_wallet_entries e ON e.owner_id=l.owner_id AND e.id=l.card_entry_id
      WHERE l.owner_id=NEW.owner_id AND l.cash_entry_id=original.id AND l.reversal_of IS NULL
       AND l.account_id=NEW.account_id AND l.account_kind=NEW.account_kind AND l.currency=NEW.currency
       AND l.cash_delta=original.amount AND l.card_delta=-original.amount AND e.currency=NEW.currency
       AND e.deleted_at IS NOT NULL)
 ) THEN RAISE EXCEPTION 'fund retirement requires its exact unlinked inverse posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- The cash row is inserted before its link. At commit a card inverse must have
-- that link and the retained cancelled card fact; a bare inverse cannot commit.
CREATE FUNCTION require_card_cash_reversal_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reversal_entry_id IS NULL THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM card_wallet_cash_links p WHERE p.owner_id=NEW.owner_id
       AND p.cash_entry_id=NEW.reversal_entry_id AND p.reversal_of IS NULL)
 AND NOT EXISTS(
   SELECT 1 FROM card_wallet_cash_links p
   JOIN card_wallet_cash_links r ON r.owner_id=p.owner_id AND r.reversal_of=p.request_id
   JOIN card_wallet_entries e ON e.owner_id=p.owner_id AND e.id=p.card_entry_id
   WHERE p.owner_id=NEW.owner_id AND p.cash_entry_id=NEW.reversal_entry_id AND p.reversal_of IS NULL
    AND r.cash_entry_id=NEW.id AND r.card_entry_id=p.card_entry_id
    AND r.account_id=NEW.account_id AND p.account_id=NEW.account_id
    AND r.account_kind=NEW.account_kind AND p.account_kind=NEW.account_kind
    AND r.currency=NEW.currency AND p.currency=NEW.currency
    AND r.cash_delta=NEW.amount AND p.cash_delta=-NEW.amount
    AND r.card_delta=-NEW.amount AND p.card_delta=NEW.amount
    AND e.deleted_at IS NOT NULL AND e.currency=NEW.currency
 ) THEN RAISE EXCEPTION 'card cash inverse requires its retained card reversal link' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER card_cash_reversal_link_required AFTER INSERT ON cash_ledger_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_card_cash_reversal_link();
