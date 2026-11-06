-- Extend the same immutable FeePlans authority. Old rows retain unknown market/source.
ALTER TABLE fee_plan_revisions ADD COLUMN market text CHECK(market IN ('us','hk','cn','connect','options'));
ALTER TABLE fee_plan_revisions ADD COLUMN legacy_original_base64 text CHECK(length(legacy_original_base64)<=87384);
ALTER TABLE fee_plan_revisions ALTER COLUMN effective_through DROP NOT NULL;
