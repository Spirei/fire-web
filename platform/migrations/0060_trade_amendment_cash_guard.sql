-- Apply after both0057 and0058 without rewriting either applied migration.
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_posting_sign;
ALTER TABLE cash_ledger_entries ADD CONSTRAINT cash_posting_sign CHECK(
 (kind IN ('opening','external_deposit','allocation') AND amount>=0)
 OR (kind IN ('external_withdrawal','trade_buy') AND amount<=0)
 OR kind IN ('reconcile_balance','trade_sell','trade_dividend','fee_correction','trade_correction'));
-- 0058 check_native_actual_fee_refund still rejects any unverified fee refund;
-- 0057 check_trade_amendment_cash/posting still bind exact correction deltas.
