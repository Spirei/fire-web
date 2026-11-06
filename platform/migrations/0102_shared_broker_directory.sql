-- Shared public labels are separate from personally owned brokerage accounts.
CREATE TABLE shared_broker_directory(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990),
 groups jsonb NOT NULL CHECK(jsonb_typeof(groups)='array'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO shared_broker_directory(singleton,groups) VALUES(true,'[
 {"id":"longbridge","name":"长桥证劵","alias":"Longbridge"},
 {"id":"htsc","name":"华泰证劵","alias":"HTSC"},
 {"id":"ibkr","name":"盈透证券","alias":"IBKR"},
 {"id":"futu","name":"富途证券","alias":"Futu"},
 {"id":"ths","name":"同花顺","alias":"10jqka"},
 {"id":"eastmoney","name":"东方财富","alias":"东财"},
 {"id":"tiger","name":"老虎证券","alias":"Tiger"},
 {"id":"robinhood","name":"罗宾汉","alias":"Robinhood"},
 {"id":"schwab","name":"嘉信理财","alias":"Schwab"}
]'::jsonb);
CREATE TABLE shared_broker_directory_operations(
 actor_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER immutable_shared_broker_operations BEFORE UPDATE OR DELETE ON shared_broker_directory_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE shared_broker_directory_previews(
 actor_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 revision bigint NOT NULL, groups jsonb NOT NULL, fingerprint text NOT NULL,
 authorization_binding text NOT NULL, plan jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 PRIMARY KEY(actor_id,id)
);
CREATE TRIGGER immutable_shared_broker_previews BEFORE UPDATE ON shared_broker_directory_previews
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
