-- Assign missing display numbers without changing the order facts, ledger revisions or receipts.
WITH missing AS (
    SELECT head.owner_id, item->>'tradeId' AS order_id,
           nextval('trade_presentation_number')::text AS number
    FROM native_ledger_heads head
    CROSS JOIN LATERAL jsonb_array_elements(head.snapshot->'orders') AS orders(item)
    WHERE COALESCE(head.snapshot->'orderNumbers'->>(item->>'tradeId'), '') = ''
), issued AS (
    SELECT owner_id, jsonb_object_agg(order_id, number) AS numbers
    FROM missing
    GROUP BY owner_id
)
UPDATE native_ledger_heads head
SET snapshot = jsonb_set(head.snapshot, '{orderNumbers}',
    COALESCE(head.snapshot->'orderNumbers', '{}'::jsonb) || issued.numbers)
FROM issued
WHERE head.owner_id = issued.owner_id;
